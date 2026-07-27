import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerEntry } from '../ledger/schemas/ledger-entry.schema';
import { OutboxService } from '../outbox/outbox.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionType } from '../transactions/schemas/transaction.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { Transfer } from './schemas/transfer.schema';
import { Wallet } from './schemas/wallet.schema';
import { WalletsService } from './wallets.service';

describe('WalletsService', () => {
  let service: WalletsService;
  let walletModel: any;
  let transferModel: any;
  let transactionModel: any;
  let ledgerEntryModel: any;
  let transactionsService: any;
  let ledgerService: any;
  let outboxService: any;
  let redisService: any;

  const mockSession = {
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn(),
  };

  beforeEach(async () => {
    walletModel = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      exists: jest.fn(),
    };
    transferModel = {
      create: jest.fn(),
      findOne: jest.fn(),
    };
    transactionModel = {
      create: jest.fn(),
      find: jest.fn(),
    };
    ledgerEntryModel = {
      find: jest.fn(),
    };
    transactionsService = { create: jest.fn(), findByReference: jest.fn() };
    ledgerService = { recordCredit: jest.fn(), recordDebit: jest.fn() };
    outboxService = { enqueue: jest.fn() };
    redisService = {
      getCachedBalance: jest.fn(),
      setCachedBalance: jest.fn(),
      invalidateBalance: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        {
          provide: getConnectionToken(),
          useValue: { startSession: jest.fn().mockResolvedValue(mockSession) },
        },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: getModelToken(LedgerEntry.name), useValue: ledgerEntryModel },
        { provide: TransactionsService, useValue: transactionsService },
        { provide: LedgerService, useValue: ledgerService },
        { provide: OutboxService, useValue: outboxService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get(WalletsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createWallet', () => {
    it('creates a wallet with a zero opening balance and enqueues a wallet.created event', async () => {
      const created = {
        _id: new Types.ObjectId(),
        userId: 'user-1',
        ownerName: 'Ama Owusu',
        balance: 0,
      };
      walletModel.create.mockResolvedValue([created]);

      const result = await service.createWallet({ userId: 'user-1', ownerName: 'Ama Owusu' });

      expect(walletModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ userId: 'user-1', balance: 0 })],
        expect.objectContaining({ session: mockSession }),
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'wallet.created',
        expect.objectContaining({ walletId: created._id.toString() }),
        mockSession,
      );
      expect(result).toBe(created);
    });
  });

  describe('getWallet', () => {
    it('seeds the cache from Mongo on a cache miss', async () => {
      const wallet = {
        id: 'w1',
        _id: 'w1',
        balance: 250,
        toObject: () => ({ id: 'w1', balance: 250 }),
      };
      walletModel.findById.mockResolvedValue(wallet);
      redisService.getCachedBalance.mockResolvedValue(null);

      const result = await service.getWallet('w1');

      expect(redisService.setCachedBalance).toHaveBeenCalledWith('w1', 250);
      expect(result).toBe(wallet);
    });

    it('returns the cached balance instead of re-reading Mongo on a cache hit', async () => {
      const wallet = {
        id: 'w1',
        _id: 'w1',
        balance: 250,
        toObject: () => ({ id: 'w1', balance: 250 }),
      };
      walletModel.findById.mockResolvedValue(wallet);
      redisService.getCachedBalance.mockResolvedValue(99);

      const result = await service.getWallet('w1');

      expect(redisService.setCachedBalance).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ balance: 99 }));
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findById.mockResolvedValue(null);

      await expect(service.getWallet('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deposit', () => {
    it('increments the balance atomically and records a ledger credit', async () => {
      const walletId = new Types.ObjectId().toString();
      const updatedWallet = { id: walletId, _id: walletId, balance: 150 };
      walletModel.findByIdAndUpdate.mockResolvedValue(updatedWallet);
      const transaction = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(transaction);

      const result = await service.deposit(walletId, { amount: 50 });

      expect(walletModel.findByIdAndUpdate).toHaveBeenCalledWith(
        walletId,
        { $inc: { balance: 50, version: 1 } },
        { new: true, session: mockSession },
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: TransactionType.DEPOSIT, amount: 50 }),
        mockSession,
      );
      expect(ledgerService.recordCredit).toHaveBeenCalledWith(
        updatedWallet._id,
        transaction._id,
        50,
        150,
        mockSession,
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'wallet.deposited',
        expect.objectContaining({ walletId, amount: 50, balanceAfter: 150 }),
        mockSession,
      );
      expect(redisService.invalidateBalance).toHaveBeenCalledWith(walletId);
      expect(result).toBe(updatedWallet);
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findByIdAndUpdate.mockResolvedValue(null);

      await expect(service.deposit('missing-id', { amount: 10 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does not invalidate the cache when the transaction fails', async () => {
      const walletId = new Types.ObjectId().toString();
      walletModel.findByIdAndUpdate.mockResolvedValue({ id: walletId, _id: walletId, balance: 50 });
      transactionsService.create.mockRejectedValue(new Error('transaction write failed'));

      await expect(service.deposit(walletId, { amount: 50 })).rejects.toThrow(
        'transaction write failed',
      );

      expect(mockSession.endSession).toHaveBeenCalled();
      expect(ledgerService.recordCredit).not.toHaveBeenCalled();
      expect(outboxService.enqueue).not.toHaveBeenCalled();
      expect(redisService.invalidateBalance).not.toHaveBeenCalled();
    });

    it('returns the wallet without another mutation when a deposit reference is retried', async () => {
      const walletId = new Types.ObjectId().toString();
      const wallet = { _id: walletId, balance: 100 };
      transactionsService.findByReference.mockResolvedValue({ amount: 100 });
      walletModel.findById.mockResolvedValue(wallet);

      const result = await service.deposit(walletId, { amount: 100, reference: 'deposit-1' });

      expect(transactionsService.findByReference).toHaveBeenCalledWith(
        walletId,
        TransactionType.DEPOSIT,
        'deposit-1',
      );
      expect(walletModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(result).toBe(wallet);
    });

    it('rejects a deposit reference reused with a different amount', async () => {
      transactionsService.findByReference.mockResolvedValue({ amount: 100 });

      await expect(
        service.deposit(new Types.ObjectId().toString(), { amount: 101, reference: 'deposit-1' }),
      ).rejects.toThrow('Idempotency reference was already used with a different amount');

      expect(walletModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    it('debits the wallet when the balance is sufficient', async () => {
      const wallet = { id: 'w1', _id: 'w1', balance: 60 };
      walletModel.findOneAndUpdate.mockResolvedValue(wallet);
      const transaction = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(transaction);

      const result = await service.withdraw('w1', { amount: 40 });

      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'w1', balance: { $gte: 40 } },
        { $inc: { balance: -40, version: 1 } },
        { new: true, session: mockSession },
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: TransactionType.WITHDRAWAL, amount: 40 }),
        mockSession,
      );
      expect(ledgerService.recordDebit).toHaveBeenCalledWith(
        wallet._id,
        transaction._id,
        40,
        60,
        mockSession,
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'wallet.withdrawn',
        expect.objectContaining({ walletId: 'w1', amount: 40, balanceAfter: 60 }),
        mockSession,
      );
      expect(redisService.invalidateBalance).toHaveBeenCalledWith('w1');
      expect(result).toBe(wallet);
    });

    it('rejects a withdrawal larger than the current balance', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);
      walletModel.exists.mockReturnValue({
        session: jest.fn().mockResolvedValue({ _id: 'w1' }),
      });

      await expect(service.withdraw('w1', { amount: 40 })).rejects.toThrow(BadRequestException);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);
      walletModel.exists.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });

      await expect(service.withdraw('missing-id', { amount: 10 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the wallet without another mutation when a withdrawal reference is retried', async () => {
      const wallet = { _id: 'w1', balance: 60 };
      transactionsService.findByReference.mockResolvedValue({ amount: 40 });
      walletModel.findById.mockResolvedValue(wallet);

      const result = await service.withdraw('w1', { amount: 40, reference: 'withdrawal-1' });

      expect(transactionsService.findByReference).toHaveBeenCalledWith(
        'w1',
        TransactionType.WITHDRAWAL,
        'withdrawal-1',
      );
      expect(walletModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result).toBe(wallet);
    });
  });

  describe('transfer', () => {
    const fromId = new Types.ObjectId();
    const toId = new Types.ObjectId();

    function mockWallets(fromBalance: number) {
      const fromWallet = { _id: fromId, balance: fromBalance };
      const toWallet = { _id: toId, balance: 0 };
      walletModel.exists.mockImplementation(({ _id }: { _id: unknown }) => ({
        session: jest
          .fn()
          .mockResolvedValue(
            String(_id) === String(fromId) || String(_id) === String(toId) ? { _id } : null,
          ),
      }));
      walletModel.findOneAndUpdate.mockImplementation((_filter: { balance: { $gte: number } }) => {
        const amount = _filter.balance.$gte;
        if (fromBalance < amount) return Promise.resolve(null);
        fromWallet.balance = fromBalance - amount;
        return Promise.resolve(fromWallet);
      });
      return { fromWallet, toWallet };
    }

    it('rejects transfers between the same wallet', async () => {
      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: fromId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when either wallet is missing', async () => {
      walletModel.exists.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a transfer larger than the sender balance', async () => {
      mockWallets(5);

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('debits the sender, records a ledger entry, and enqueues a transfer event transactionally', async () => {
      const { fromWallet } = mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), toWalletId: toId, status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      const debitTransaction = { _id: new Types.ObjectId() };
      transactionModel.create.mockResolvedValue([debitTransaction]);

      const result = await service.transfer({
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
      });

      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: fromId.toString(), balance: { $gte: 30 } },
        { $inc: { balance: -30, version: 1 } },
        { new: true, session: mockSession },
      );
      expect(fromWallet.balance).toBe(70);
      expect(ledgerService.recordDebit).toHaveBeenCalledWith(
        fromWallet._id,
        debitTransaction._id,
        30,
        70,
        mockSession,
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'transfer.initiated',
        expect.objectContaining({ transferId: createdTransfer._id.toString(), amount: 30 }),
        mockSession,
      );
      expect(redisService.invalidateBalance).toHaveBeenCalledWith(fromId.toString());
      expect(result).toBe(createdTransfer);
    });

    it('does not create a second transfer when retried with the same idempotency key', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), toWalletId: toId, status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      transactionModel.create.mockResolvedValue([{ _id: new Types.ObjectId() }]);
      transferModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(createdTransfer);

      const dto = {
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
        idempotencyKey: 'retry-key-1',
      };

      await service.transfer(dto);
      await service.transfer(dto);

      expect(transferModel.create).toHaveBeenCalledTimes(1);
      expect(outboxService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('returns the persisted transfer after a concurrent idempotency-key conflict', async () => {
      mockWallets(100);
      const existingTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existingTransfer);
      transferModel.create.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: 11000 }),
      );

      const result = await service.transfer({
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
        idempotencyKey: 'concurrent-retry-key',
      });

      expect(result).toBe(existingTransfer);
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('ends the Mongo session even when the transaction fails partway through', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), toWalletId: toId, status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      transactionModel.create.mockRejectedValue(new Error('write conflict'));

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 30,
        }),
      ).rejects.toThrow('write conflict');

      expect(mockSession.endSession).toHaveBeenCalled();
      expect(outboxService.enqueue).not.toHaveBeenCalled();
    });
  });
});
