import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConsumeMessage } from 'amqplib';
import { Connection, isValidObjectId, Model } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';

export interface TransferInitiatedEvent {
  transferId: string;
  fromWalletId: string;
  toWalletId: string;
  amount: number;
}

class InvalidTransferEventError extends Error {}

@Injectable()
export class TransferEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(TransferEventsConsumer.name);

  constructor(
    private readonly rabbitMQService: RabbitMQService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    private readonly ledgerService: LedgerService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    const channelWrapper = this.rabbitMQService.getChannelWrapper();
    const queue = this.rabbitMQService.getTransferQueue();

    channelWrapper.addSetup((channel) =>
      channel.consume(queue, (message) => this.handleMessage(message, channel), { noAck: false }),
    );
  }

  private async handleMessage(message: ConsumeMessage | null, channel: any) {
    if (!message) return;

    try {
      const event: TransferInitiatedEvent = JSON.parse(message.content.toString());
      await this.completeTransfer(event);
      channel.ack(message);
    } catch (error) {
      this.logger.error(`Failed to process transfer event: ${(error as Error).message}`);
      if (error instanceof SyntaxError || error instanceof InvalidTransferEventError) {
        channel.ack(message);
      } else {
        channel.nack(message, false, true);
      }
    }
  }

  private async completeTransfer(event: TransferInitiatedEvent) {
    this.validateEvent(event);
    const session = await this.connection.startSession();
    let settled = false;

    try {
      await session.withTransaction(async () => {
        const transfer = await this.transferModel.findOneAndUpdate(
          {
            _id: event.transferId,
            status: TransferStatus.PENDING,
            fromWalletId: event.fromWalletId,
            toWalletId: event.toWalletId,
            amount: event.amount,
          },
          { $set: { status: TransferStatus.COMPLETED } },
          { new: true, session },
        );

        if (!transfer) {
          const existing = await this.transferModel.findById(event.transferId).session(session);
          if (!existing) {
            this.logger.warn(`Transfer ${event.transferId} not found, skipping`);
            return;
          }
          if (existing.status === TransferStatus.COMPLETED) return;
          throw new InvalidTransferEventError(
            `Transfer ${event.transferId} does not match the event or cannot be settled`,
          );
        }

        const toWallet = await this.walletModel.findByIdAndUpdate(
          transfer.toWalletId,
          { $inc: { balance: transfer.amount, version: 1 } },
          { new: true, session },
        );
        if (!toWallet) {
          throw new Error(`Destination wallet ${transfer.toWalletId.toString()} not found`);
        }

        const [creditTransaction] = await this.transactionModel.create(
          [
            {
              walletId: toWallet._id,
              type: TransactionType.TRANSFER_IN,
              amount: transfer.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: toWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: transfer.fromWalletId,
            },
          ],
          { session },
        );

        await this.ledgerService.recordCredit(
          toWallet._id,
          creditTransaction._id,
          transfer.amount,
          toWallet.balance,
          session,
        );
        settled = true;
      });
    } finally {
      await session.endSession();
    }

    if (settled) {
      try {
        await this.redisService.invalidateBalance(event.toWalletId);
      } catch (error) {
        this.logger.warn(
          `Could not invalidate balance cache for wallet ${event.toWalletId}: ${(error as Error).message}`,
        );
      }
      this.logger.log(`Transfer ${event.transferId} completed for wallet ${event.toWalletId}`);
    }
  }

  private validateEvent(event: TransferInitiatedEvent) {
    if (
      !isValidObjectId(event.transferId) ||
      !isValidObjectId(event.fromWalletId) ||
      !isValidObjectId(event.toWalletId) ||
      !Number.isFinite(event.amount) ||
      event.amount <= 0
    ) {
      throw new InvalidTransferEventError('Invalid transfer event payload');
    }
  }
}
