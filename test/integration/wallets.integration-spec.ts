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

  it('applies concurrent deposit retries with the same reference exactly once', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'deposit-idempotency', ownerName: 'Deposit Idempotency' })
      .expect(201);
    const request = { amount: 100, reference: 'deposit-reference-1' };

    const responses = await Promise.all([
      client.post(`/wallets/${wallet.body._id}/deposit`).send(request),
      client.post(`/wallets/${wallet.body._id}/deposit`).send(request),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect((await getModel(app, Wallet.name).findById(wallet.body._id))?.balance).toBe(100);
    expect(
      await getModel(app, Transaction.name).countDocuments({
        walletId: wallet.body._id,
        type: TransactionType.DEPOSIT,
        reference: request.reference,
      }),
    ).toBe(1);
    expect(
      await getModel(app, LedgerEntry.name).countDocuments({ walletId: wallet.body._id }),
    ).toBe(1);

    await client
      .post(`/wallets/${wallet.body._id}/deposit`)
      .send({ amount: 101, reference: request.reference })
      .expect(409);
  });

  it('applies concurrent withdrawal retries with the same reference exactly once', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'withdrawal-idempotency', ownerName: 'Withdrawal Idempotency' })
      .expect(201);
    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 100 }).expect(201);
    const request = { amount: 40, reference: 'withdrawal-reference-1' };

    const responses = await Promise.all([
      client.post(`/wallets/${wallet.body._id}/withdraw`).send(request),
      client.post(`/wallets/${wallet.body._id}/withdraw`).send(request),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect((await getModel(app, Wallet.name).findById(wallet.body._id))?.balance).toBe(60);
    expect(
      await getModel(app, Transaction.name).countDocuments({
        walletId: wallet.body._id,
        type: TransactionType.WITHDRAWAL,
        reference: request.reference,
      }),
    ).toBe(1);
    expect(
      await getModel(app, LedgerEntry.name).countDocuments({ walletId: wallet.body._id }),
    ).toBe(2);

    await client
      .post(`/wallets/${wallet.body._id}/withdraw`)
      .send({ amount: 41, reference: request.reference })
      .expect(409);
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

  it('summarizes full history while returning only ten recent dashboard activities', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'dashboard-user', ownerName: 'Dashboard User' })
      .expect(201);

    for (let index = 0; index < 12; index += 1) {
      await client
        .post(`/wallets/${wallet.body._id}/deposit`)
        .send({ amount: 10, reference: `dashboard-deposit-${index}` })
        .expect(201);
    }
    await client
      .post(`/wallets/${wallet.body._id}/withdraw`)
      .send({ amount: 20, reference: 'dashboard-withdrawal' })
      .expect(201);

    await client
      .get(`/wallets/${wallet.body._id}/dashboard`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.totalDeposited).toBe(120);
        expect(body.totalWithdrawn).toBe(20);
        expect(body.transactionCount).toBe(13);
        expect(body.recentActivity).toHaveLength(10);
        expect(
          body.recentActivity.every((item: { entries: unknown[] }) => item.entries.length === 1),
        ).toBe(true);
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
