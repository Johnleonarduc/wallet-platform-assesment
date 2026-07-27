import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Transaction, TransactionType } from './schemas/transaction.schema';
import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let transactionModel: any;

  beforeEach(async () => {
    transactionModel = {
      create: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  it('creates a transaction document', async () => {
    const created = { _id: '1', type: TransactionType.DEPOSIT };
    transactionModel.create.mockResolvedValue([created]);

    const result = await service.create({
      walletId: 'wallet-1',
      type: TransactionType.DEPOSIT,
      amount: 100,
      balanceAfter: 100,
    });

    expect(transactionModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ walletId: 'wallet-1', amount: 100 })],
      undefined,
    );
    expect(result).toBe(created);
  });

  it('paginates results and returns a total count', async () => {
    const items = [{ id: '1' }, { id: '2' }];
    const execMock = jest.fn().mockResolvedValue(items);
    transactionModel.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: execMock,
    });
    transactionModel.countDocuments.mockResolvedValue(42);

    const result = await service.findAll({ page: 2, limit: 2 });

    expect(result).toEqual({ items, total: 42, page: 2, limit: 2 });
  });

  it('looks up an idempotent mutation by wallet, type, and reference', async () => {
    const transaction = { _id: 'txn-1' };
    const exec = jest.fn().mockResolvedValue(transaction);
    transactionModel.findOne.mockReturnValue({ exec });

    const result = await service.findByReference(
      'wallet-1',
      TransactionType.WITHDRAWAL,
      'withdrawal-1',
    );

    expect(transactionModel.findOne).toHaveBeenCalledWith({
      walletId: 'wallet-1',
      type: TransactionType.WITHDRAWAL,
      reference: 'withdrawal-1',
    });
    expect(result).toBe(transaction);
  });
});
