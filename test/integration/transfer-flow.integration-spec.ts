import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { LedgerEntry } from '../../src/ledger/schemas/ledger-entry.schema';
import { OutboxEvent } from '../../src/outbox/schemas/outbox-event.schema';
import { TransferEventsConsumer } from '../../src/queue/transfer-events.consumer';
import { Transaction, TransactionType } from '../../src/transactions/schemas/transaction.schema';
import { Transfer } from '../../src/wallets/schemas/transfer.schema';
import { Wallet } from '../../src/wallets/schemas/wallet.schema';
import { PendingTransferWorker } from '../../src/workers/pending-transfer.worker';
import { createAuthenticatedRequest, createTestApp, getModel, resetDatabase } from './test-utils';

async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 8000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('Transfer flow (integration)', () => {
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

  it('debits the sender immediately and eventually credits the receiver once the event is consumed', async () => {
    const walletModel = getModel(app, Wallet.name);
    const transferModel = getModel(app, Transfer.name);

    const fromWallet = await client
      .post('/wallets')
      .send({ userId: 'sender', ownerName: 'Ama Owusu' })
      .expect(201);
    const toWallet = await client
      .post('/wallets')
      .send({ userId: 'receiver', ownerName: 'Kwame Mensah' })
      .expect(201);

    await client.post(`/wallets/${fromWallet.body._id}/deposit`).send({ amount: 500 }).expect(201);
    await client.get(`/wallets/${fromWallet.body._id}`).expect(200);
    await client.get(`/wallets/${toWallet.body._id}`).expect(200);

    const transferResponse = await client
      .post('/wallets/transfer')
      .send({ fromWalletId: fromWallet.body._id, toWalletId: toWallet.body._id, amount: 120 })
      .expect(201);

    expect(transferResponse.body.status).toBe('PENDING');

    const senderWallet = await walletModel.findById(fromWallet.body._id);
    expect(senderWallet).toBeTruthy();

    const settled = await pollUntil(async () => {
      const transfer = await transferModel.findById(transferResponse.body._id);
      return transfer?.status === 'COMPLETED';
    });

    expect(settled).toBe(true);

    const receiverWallet = await walletModel.findById(toWallet.body._id);
    expect(receiverWallet?.balance).toBe(120);
    await client
      .get(`/wallets/${fromWallet.body._id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.balance).toBe(380);
      });
    await client
      .get(`/wallets/${toWallet.body._id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.balance).toBe(120);
      });

    const outboxEvent = await getModel(app, OutboxEvent.name).findOne({
      routingKey: 'transfer.initiated',
      'payload.transferId': transferResponse.body._id,
    });
    expect(outboxEvent).toBeTruthy();
  });

  it('recovers a stale pending transfer by enqueueing a new settlement event', async () => {
    const walletModel = getModel(app, Wallet.name);
    const transferModel = getModel(app, Transfer.name);
    const outboxModel = getModel(app, OutboxEvent.name);
    const sender = await walletModel.create({
      userId: 'recovery-sender',
      ownerName: 'Recovery Sender',
      balance: 125,
    });
    const receiver = await walletModel.create({
      userId: 'recovery-receiver',
      ownerName: 'Recovery Receiver',
      balance: 0,
    });
    const transfer = await transferModel.create({
      fromWalletId: sender._id,
      toWalletId: receiver._id,
      amount: 75,
      status: 'PENDING',
      createdAt: new Date(Date.now() - 120_000),
      updatedAt: new Date(Date.now() - 120_000),
    });

    const recoveryWorker = app.get(PendingTransferWorker);
    await Promise.all([recoveryWorker.sweep(), recoveryWorker.sweep()]);

    const recoveryEvent = await outboxModel.findOne({
      routingKey: 'transfer.initiated',
      'payload.transferId': transfer._id.toString(),
      'payload.recoveryAttempt': 1,
    });
    expect(recoveryEvent).toBeTruthy();
    expect(
      await outboxModel.countDocuments({
        routingKey: 'transfer.initiated',
        'payload.transferId': transfer._id.toString(),
      }),
    ).toBe(1);
    expect((await transferModel.findById(transfer._id))?.recoveryAttempts).toBe(1);

    const settled = await pollUntil(async () => {
      return (await transferModel.findById(transfer._id))?.status === 'COMPLETED';
    });
    expect(settled).toBe(true);
    expect((await walletModel.findById(receiver._id))?.balance).toBe(75);
    expect((await transferModel.findById(transfer._id))?.failureReason).toBeUndefined();
  });

  it('flags a stale transfer for manual review after recovery attempts are exhausted', async () => {
    const walletModel = getModel(app, Wallet.name);
    const transferModel = getModel(app, Transfer.name);
    const outboxModel = getModel(app, OutboxEvent.name);
    const sender = await walletModel.create({
      userId: 'exhausted-sender',
      ownerName: 'Exhausted Sender',
      balance: 25,
    });
    const receiver = await walletModel.create({
      userId: 'exhausted-receiver',
      ownerName: 'Exhausted Receiver',
      balance: 0,
    });
    const transfer = await transferModel.create({
      fromWalletId: sender._id,
      toWalletId: receiver._id,
      amount: 25,
      status: 'PENDING',
      recoveryAttempts: 5,
      nextRecoveryAt: new Date(Date.now() - 1_000),
      createdAt: new Date(Date.now() - 120_000),
      updatedAt: new Date(Date.now() - 120_000),
    });

    await app.get(PendingTransferWorker).sweep();

    expect((await transferModel.findById(transfer._id))?.failureReason).toBe(
      'Recovery attempts exhausted; manual review required',
    );
    expect(
      await outboxModel.countDocuments({ 'payload.transferId': transfer._id.toString() }),
    ).toBe(0);
  });

  it('rejects transferring more than the sender holds and leaves both wallets untouched', async () => {
    const walletModel = getModel(app, Wallet.name);

    const fromWallet = await client
      .post('/wallets')
      .send({ userId: 'sender-2', ownerName: 'Efua Asante' })
      .expect(201);
    const toWallet = await client
      .post('/wallets')
      .send({ userId: 'receiver-2', ownerName: 'Kofi Boateng' })
      .expect(201);

    await client.post(`/wallets/${fromWallet.body._id}/deposit`).send({ amount: 10 }).expect(201);

    await client
      .post('/wallets/transfer')
      .send({ fromWalletId: fromWallet.body._id, toWalletId: toWallet.body._id, amount: 100 })
      .expect(400);

    const senderWallet = await walletModel.findById(fromWallet.body._id);
    const receiverWallet = await walletModel.findById(toWallet.body._id);

    expect(senderWallet?.balance).toBe(10);
    expect(receiverWallet?.balance).toBe(0);
  });

  it('returns the original transfer when an idempotency key is retried', async () => {
    const walletModel = getModel(app, Wallet.name);
    const transferModel = getModel(app, Transfer.name);
    const fromWallet = await client
      .post('/wallets')
      .send({ userId: 'retry-sender', ownerName: 'Retry Sender' })
      .expect(201);
    const toWallet = await client
      .post('/wallets')
      .send({ userId: 'retry-receiver', ownerName: 'Retry Receiver' })
      .expect(201);
    await client.post(`/wallets/${fromWallet.body._id}/deposit`).send({ amount: 100 }).expect(201);

    const request = {
      fromWalletId: fromWallet.body._id,
      toWalletId: toWallet.body._id,
      amount: 30,
      idempotencyKey: 'integration-retry-key',
    };
    const first = await client.post('/wallets/transfer').send(request).expect(201);
    const retry = await client.post('/wallets/transfer').send(request).expect(201);

    expect(retry.body._id).toBe(first.body._id);
    expect(await transferModel.countDocuments({ idempotencyKey: request.idempotencyKey })).toBe(1);
    expect((await walletModel.findById(fromWallet.body._id))?.balance).toBe(70);
  });

  it('credits the receiver exactly once when a transfer event is delivered twice', async () => {
    const walletModel = getModel(app, Wallet.name);
    const transferModel = getModel(app, Transfer.name);
    const transactionModel = getModel(app, Transaction.name);
    const ledgerEntryModel = getModel(app, LedgerEntry.name);
    const consumer = app.get(TransferEventsConsumer);
    const fromWallet = await client
      .post('/wallets')
      .send({ userId: 'duplicate-sender', ownerName: 'Duplicate Sender' })
      .expect(201);
    const toWallet = await client
      .post('/wallets')
      .send({ userId: 'duplicate-receiver', ownerName: 'Duplicate Receiver' })
      .expect(201);
    const transfer = await transferModel.create({
      fromWalletId: fromWallet.body._id,
      toWalletId: toWallet.body._id,
      amount: 25,
      status: 'PENDING',
      idempotencyKey: 'duplicate-delivery-test',
    });
    const event = {
      transferId: transfer._id.toString(),
      fromWalletId: fromWallet.body._id,
      toWalletId: toWallet.body._id,
      amount: 25,
    };

    await (consumer as any).completeTransfer(event);
    await (consumer as any).completeTransfer(event);

    const creditTransactions = await transactionModel.find({
      transferId: transfer._id,
      type: TransactionType.TRANSFER_IN,
    });
    const creditLedgerEntries = await ledgerEntryModel.find({
      transactionId: { $in: creditTransactions.map((transaction: any) => transaction._id) },
    });
    expect((await walletModel.findById(toWallet.body._id))?.balance).toBe(25);
    expect(creditTransactions).toHaveLength(1);
    expect(creditLedgerEntries).toHaveLength(1);
    expect((await transferModel.findById(transfer._id))?.status).toBe('COMPLETED');
  });
});
