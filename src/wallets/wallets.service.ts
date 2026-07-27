import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { LedgerEntry, LedgerEntryDocument } from '../ledger/schemas/ledger-entry.schema';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { RedisService } from '../redis/redis.service';
import { TransactionsService } from '../transactions/transactions.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { Transfer, TransferDocument, TransferStatus } from './schemas/transfer.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntryDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly redisService: RedisService,
  ) {}

  async createWallet(dto: CreateWalletDto) {
    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        [wallet] = await this.walletModel.create(
          [
            {
              userId: dto.userId,
              ownerName: dto.ownerName,
              currency: dto.currency ?? 'GHS',
              balance: 0,
            },
          ],
          { session },
        );

        await this.outboxService.enqueue(
          'wallet.created',
          {
            walletId: wallet._id.toString(),
            userId: wallet.userId,
            currency: wallet.currency,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    return wallet;
  }

  async getWallet(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const cachedBalance = await this.redisService.getCachedBalance(id);
    if (cachedBalance !== null) {
      return { ...wallet.toObject(), balance: cachedBalance };
    }

    await this.redisService.setCachedBalance(id, wallet.balance);
    return wallet;
  }

  async deposit(id: string, dto: DepositDto) {
    if (dto.reference) {
      const existingWallet = await this.resolveMutationRetry(
        id,
        TransactionType.DEPOSIT,
        dto.amount,
        dto.reference,
      );
      if (existingWallet) return existingWallet;
    }

    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        const updatedWallet = await this.walletModel.findByIdAndUpdate(
          id,
          { $inc: { balance: dto.amount, version: 1 } },
          { new: true, session },
        );
        if (!updatedWallet) {
          throw new NotFoundException(`Wallet ${id} not found`);
        }
        wallet = updatedWallet;

        const transaction = await this.transactionsService.create(
          {
            walletId: wallet.id,
            type: TransactionType.DEPOSIT,
            amount: dto.amount,
            balanceAfter: wallet.balance,
            reference: dto.reference,
          },
          session,
        );

        await this.ledgerService.recordCredit(
          wallet._id,
          transaction._id,
          dto.amount,
          wallet.balance,
          session,
        );
        await this.outboxService.enqueue(
          'wallet.deposited',
          {
            walletId: wallet._id.toString(),
            transactionId: transaction._id.toString(),
            amount: dto.amount,
            balanceAfter: wallet.balance,
          },
          session,
        );
      });
    } catch (error) {
      if (dto.reference && this.isDuplicateKeyError(error)) {
        const existingWallet = await this.resolveMutationRetry(
          id,
          TransactionType.DEPOSIT,
          dto.amount,
          dto.reference,
        );
        if (existingWallet) return existingWallet;
      }
      throw error;
    } finally {
      await session.endSession();
    }
    await this.safeInvalidateBalance(id);

    return wallet;
  }

  async withdraw(id: string, dto: WithdrawDto) {
    if (dto.reference) {
      const existingWallet = await this.resolveMutationRetry(
        id,
        TransactionType.WITHDRAWAL,
        dto.amount,
        dto.reference,
      );
      if (existingWallet) return existingWallet;
    }

    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        const updatedWallet = await this.walletModel.findOneAndUpdate(
          { _id: id, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount, version: 1 } },
          { new: true, session },
        );

        if (!updatedWallet) {
          const exists = await this.walletModel.exists({ _id: id }).session(session);
          if (!exists) {
            throw new NotFoundException(`Wallet ${id} not found`);
          }
          throw new BadRequestException('Insufficient balance');
        }
        wallet = updatedWallet;

        const transaction = await this.transactionsService.create(
          {
            walletId: wallet.id,
            type: TransactionType.WITHDRAWAL,
            amount: dto.amount,
            balanceAfter: wallet.balance,
            reference: dto.reference,
          },
          session,
        );

        await this.ledgerService.recordDebit(
          wallet._id,
          transaction._id,
          dto.amount,
          wallet.balance,
          session,
        );
        await this.outboxService.enqueue(
          'wallet.withdrawn',
          {
            walletId: wallet._id.toString(),
            transactionId: transaction._id.toString(),
            amount: dto.amount,
            balanceAfter: wallet.balance,
          },
          session,
        );
      });
    } catch (error) {
      if (dto.reference && this.isDuplicateKeyError(error)) {
        const existingWallet = await this.resolveMutationRetry(
          id,
          TransactionType.WITHDRAWAL,
          dto.amount,
          dto.reference,
        );
        if (existingWallet) return existingWallet;
      }
      throw error;
    } finally {
      await session.endSession();
    }
    await this.safeInvalidateBalance(id);

    return wallet;
  }

  async transfer(dto: TransferDto) {
    if (dto.fromWalletId === dto.toWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    if (dto.idempotencyKey) {
      const existingTransfer = await this.transferModel.findOne({
        idempotencyKey: dto.idempotencyKey,
      });
      if (existingTransfer) {
        return existingTransfer;
      }
    }

    const session = await this.connection.startSession();
    let transfer!: TransferDocument;

    try {
      await session.withTransaction(async () => {
        const destinationExists = await this.walletModel
          .exists({ _id: dto.toWalletId })
          .session(session);
        if (!destinationExists) {
          throw new NotFoundException('Wallet not found');
        }

        const fromWallet = await this.walletModel.findOneAndUpdate(
          { _id: dto.fromWalletId, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount, version: 1 } },
          { new: true, session },
        );
        if (!fromWallet) {
          const senderExists = await this.walletModel
            .exists({ _id: dto.fromWalletId })
            .session(session);
          if (!senderExists) {
            throw new NotFoundException('Wallet not found');
          }
          throw new BadRequestException('Insufficient balance');
        }

        [transfer] = await this.transferModel.create(
          [
            {
              fromWalletId: fromWallet._id,
              toWalletId: new Types.ObjectId(dto.toWalletId),
              amount: dto.amount,
              status: TransferStatus.PENDING,
              idempotencyKey: dto.idempotencyKey,
            },
          ],
          { session },
        );

        const [debitTransaction] = await this.transactionModel.create(
          [
            {
              walletId: fromWallet._id,
              type: TransactionType.TRANSFER_OUT,
              amount: dto.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: fromWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: transfer.toWalletId,
            },
          ],
          { session },
        );

        await this.ledgerService.recordDebit(
          fromWallet._id,
          debitTransaction._id,
          dto.amount,
          fromWallet.balance,
          session,
        );

        await this.outboxService.enqueue(
          'transfer.initiated',
          {
            transferId: transfer._id.toString(),
            fromWalletId: fromWallet._id.toString(),
            toWalletId: transfer.toWalletId.toString(),
            amount: dto.amount,
          },
          session,
        );
      });
    } catch (error) {
      if (dto.idempotencyKey && this.isDuplicateKeyError(error)) {
        const existingTransfer = await this.transferModel.findOne({
          idempotencyKey: dto.idempotencyKey,
        });
        if (existingTransfer) {
          return existingTransfer;
        }
      }
      throw error;
    } finally {
      await session.endSession();
    }

    await this.safeInvalidateBalance(dto.fromWalletId);
    return transfer;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }

  private async resolveMutationRetry(
    walletId: string,
    type: TransactionType,
    amount: number,
    reference: string,
  ): Promise<WalletDocument | null> {
    const existing = await this.transactionsService.findByReference(walletId, type, reference);
    if (!existing) return null;

    if (existing.amount !== amount) {
      throw new ConflictException('Idempotency reference was already used with a different amount');
    }

    const wallet = await this.walletModel.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }
    return wallet;
  }

  private async safeInvalidateBalance(walletId: string) {
    try {
      await this.redisService.invalidateBalance(walletId);
    } catch (error) {
      this.logger.warn(
        `Could not invalidate balance cache for wallet ${walletId}: ${(error as Error).message}`,
      );
    }
  }

  async getDashboard(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const [summaryRows, recentTransactions] = await Promise.all([
      this.transactionModel.aggregate<{
        totalDeposited: number;
        totalWithdrawn: number;
        transactionCount: number;
      }>([
        { $match: { walletId: wallet._id } },
        {
          $group: {
            _id: null,
            totalDeposited: {
              $sum: {
                $cond: [
                  { $in: ['$type', [TransactionType.DEPOSIT, TransactionType.TRANSFER_IN]] },
                  '$amount',
                  0,
                ],
              },
            },
            totalWithdrawn: {
              $sum: {
                $cond: [
                  { $in: ['$type', [TransactionType.WITHDRAWAL, TransactionType.TRANSFER_OUT]] },
                  '$amount',
                  0,
                ],
              },
            },
            transactionCount: { $sum: 1 },
          },
        },
      ]),
      this.transactionModel.find({ walletId: wallet._id }).sort({ createdAt: -1 }).limit(10).exec(),
    ]);

    const recentIds = recentTransactions.map((transaction) => transaction._id);
    const entries =
      recentIds.length === 0
        ? []
        : await this.ledgerEntryModel
            .find({ transactionId: { $in: recentIds } })
            .sort({ createdAt: 1 })
            .exec();
    const entriesByTransaction = new Map<string, LedgerEntryDocument[]>();
    for (const entry of entries) {
      const key = entry.transactionId.toString();
      const grouped = entriesByTransaction.get(key) ?? [];
      grouped.push(entry);
      entriesByTransaction.set(key, grouped);
    }

    const summary = summaryRows[0] ?? {
      totalDeposited: 0,
      totalWithdrawn: 0,
      transactionCount: 0,
    };
    const recentActivity = recentTransactions.map((transaction) => ({
      transaction,
      entries: entriesByTransaction.get(transaction._id.toString()) ?? [],
    }));

    return {
      wallet,
      totalDeposited: summary.totalDeposited,
      totalWithdrawn: summary.totalWithdrawn,
      transactionCount: summary.transactionCount,
      recentActivity,
    };
  }
}
