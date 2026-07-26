import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionType } from '../transactions/schemas/transaction.schema';
import { Transfer, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';
import { TransferEventsConsumer } from './transfer-events.consumer';

describe('TransferEventsConsumer', () => {
  let consumer: TransferEventsConsumer;
  let transferModel: any;
  let walletModel: any;
  let transactionModel: any;
  let ledgerService: any;
  let session: any;
  let redisService: any;

  beforeEach(async () => {
    session = {
      withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
      endSession: jest.fn(),
    };
    transferModel = { findOneAndUpdate: jest.fn(), findById: jest.fn() };
    walletModel = { findByIdAndUpdate: jest.fn() };
    transactionModel = { create: jest.fn() };
    ledgerService = { recordCredit: jest.fn() };
    redisService = { invalidateBalance: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferEventsConsumer,
        {
          provide: RabbitMQService,
          useValue: { getChannelWrapper: jest.fn(), getTransferQueue: jest.fn() },
        },
        {
          provide: getConnectionToken(),
          useValue: { startSession: jest.fn().mockResolvedValue(session) },
        },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: LedgerService, useValue: ledgerService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    consumer = module.get(TransferEventsConsumer);
  });

  it('credits the destination and completes the transfer in one transaction', async () => {
    const transfer = {
      _id: new Types.ObjectId(),
      fromWalletId: new Types.ObjectId(),
      toWalletId: new Types.ObjectId(),
      amount: 25,
      status: TransferStatus.COMPLETED,
    };
    const toWallet = { _id: transfer.toWalletId, balance: 125 };
    transferModel.findOneAndUpdate.mockResolvedValue(transfer);
    walletModel.findByIdAndUpdate.mockResolvedValue(toWallet);
    const creditTransaction = { _id: new Types.ObjectId() };
    transactionModel.create.mockResolvedValue([creditTransaction]);

    await (consumer as any).completeTransfer({
      transferId: transfer._id.toString(),
      fromWalletId: transfer.fromWalletId.toString(),
      toWalletId: transfer.toWalletId.toString(),
      amount: transfer.amount,
    });

    expect(walletModel.findByIdAndUpdate).toHaveBeenCalledWith(
      transfer.toWalletId,
      { $inc: { balance: 25, version: 1 } },
      { new: true, session },
    );
    expect(transactionModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: TransactionType.TRANSFER_IN,
          amount: 25,
          balanceAfter: 125,
        }),
      ],
      { session },
    );
    expect(ledgerService.recordCredit).toHaveBeenCalledWith(
      toWallet._id,
      creditTransaction._id,
      25,
      125,
      session,
    );
    expect(session.endSession).toHaveBeenCalled();
    expect(redisService.invalidateBalance).toHaveBeenCalledWith(transfer.toWalletId.toString());
  });

  it('treats a duplicate event for a completed transfer as a no-op', async () => {
    const transferId = new Types.ObjectId();
    transferModel.findOneAndUpdate.mockResolvedValue(null);
    transferModel.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue({ _id: transferId, status: TransferStatus.COMPLETED }),
    });

    await (consumer as any).completeTransfer({
      transferId: transferId.toString(),
      fromWalletId: new Types.ObjectId().toString(),
      toWalletId: new Types.ObjectId().toString(),
      amount: 25,
    });

    expect(walletModel.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(transactionModel.create).not.toHaveBeenCalled();
    expect(ledgerService.recordCredit).not.toHaveBeenCalled();
  });

  it('requeues transient settlement failures', async () => {
    const message = {
      content: Buffer.from(
        JSON.stringify({
          transferId: new Types.ObjectId().toString(),
          fromWalletId: new Types.ObjectId().toString(),
          toWalletId: new Types.ObjectId().toString(),
          amount: 25,
        }),
      ),
    } as any;
    const channel = { ack: jest.fn(), nack: jest.fn() };
    jest
      .spyOn(consumer as any, 'completeTransfer')
      .mockRejectedValue(new Error('Mongo unavailable'));

    await (consumer as any).handleMessage(message, channel);

    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('acknowledges malformed events so they do not create a poison-message loop', async () => {
    const message = { content: Buffer.from('{not-json') } as any;
    const channel = { ack: jest.fn(), nack: jest.fn() };

    await (consumer as any).handleMessage(message, channel);

    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});
