import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { LedgerService } from '../../src/ledger/ledger.service';
import { LedgerEntry } from '../../src/ledger/schemas/ledger-entry.schema';
import { OutboxService } from '../../src/outbox/outbox.service';
import { Transaction, TransactionType } from '../../src/transactions/schemas/transaction.schema';
import { Wallet } from '../../src/wallets/schemas/wallet.schema';
import { createAuthenticatedRequest, createTestApp, getModel, resetDatabase } from './test-utils';

describe('Wallets (integration)', () => {
  let app: INestApplication;
  let connection: Connection;
  let client: Awaited<ReturnType<typeof createAuthenticatedRequest>>;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  beforeEach(async () => {
    await resetDatabase(connection);
    client = await createAuthenticatedRequest(app, connection);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a wallet with a zero balance', async () => {
    const response = await client
      .post('/wallets')
      .send({ userId: 'user-1', ownerName: 'Ama Owusu' })
      .expect(201);

    expect(response.body.balance).toBe(0);
    expect(response.body.ownerName).toBe('Ama Owusu');
  });

  it('deposits funds and persists a matching ledger entry', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'user-2', ownerName: 'Kwame Mensah' })
      .expect(201);

    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 200 }).expect(201);

    const ledgerEntryModel = getModel(app, LedgerEntry.name);
    const ledgerEntries = await ledgerEntryModel.find({ walletId: wallet.body._id }).exec();

    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].direction).toBe('CREDIT');
    expect(ledgerEntries[0].amount).toBe(200);
  });

  it('rejects a withdrawal larger than the current balance', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'user-3', ownerName: 'Efua Asante' })
      .expect(201);

    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 50 }).expect(201);

    await client.post(`/wallets/${wallet.body._id}/withdraw`).send({ amount: 100 }).expect(400);
  });

  it('rejects malformed wallet creation payloads', async () => {
    await client.post('/wallets').send({ ownerName: 'Missing userId' }).expect(400);
  });

  it('does not return a stale cached balance after wallet mutations', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'cache-user', ownerName: 'Cache Test' })
      .expect(201);

    await client
      .get(`/wallets/${wallet.body._id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.balance).toBe(0);
      });
    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 100 }).expect(201);
    await client
      .get(`/wallets/${wallet.body._id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.balance).toBe(100);
      });
    await client.post(`/wallets/${wallet.body._id}/withdraw`).send({ amount: 40 }).expect(201);
    await client
      .get(`/wallets/${wallet.body._id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.balance).toBe(60);
      });
  });

  it('rolls back a deposit when its outbox write fails', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'deposit-rollback', ownerName: 'Deposit Rollback' })
      .expect(201);
    const outboxService = app.get(OutboxService);
    const enqueue = jest
      .spyOn(outboxService, 'enqueue')
      .mockRejectedValueOnce(new Error('injected outbox failure'));

    try {
      await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 100 }).expect(500);
    } finally {
      enqueue.mockRestore();
    }

    expect((await getModel(app, Wallet.name).findById(wallet.body._id))?.balance).toBe(0);
    expect(
      await getModel(app, Transaction.name).countDocuments({
        walletId: wallet.body._id,
        type: TransactionType.DEPOSIT,
      }),
    ).toBe(0);
    expect(
      await getModel(app, LedgerEntry.name).countDocuments({ walletId: wallet.body._id }),
    ).toBe(0);
  });

  it('rolls back a withdrawal when its ledger write fails', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'withdrawal-rollback', ownerName: 'Withdrawal Rollback' })
      .expect(201);
    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 100 }).expect(201);
    const ledgerService = app.get(LedgerService);
    const recordDebit = jest
      .spyOn(ledgerService, 'recordDebit')
      .mockRejectedValueOnce(new Error('injected ledger failure'));

    try {
      await client.post(`/wallets/${wallet.body._id}/withdraw`).send({ amount: 40 }).expect(500);
    } finally {
      recordDebit.mockRestore();
    }

    expect((await getModel(app, Wallet.name).findById(wallet.body._id))?.balance).toBe(100);
    expect(
      await getModel(app, Transaction.name).countDocuments({
        walletId: wallet.body._id,
        type: TransactionType.WITHDRAWAL,
      }),
    ).toBe(0);
  });
});
