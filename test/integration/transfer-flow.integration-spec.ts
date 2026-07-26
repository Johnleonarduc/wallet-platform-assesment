import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { Transfer } from '../../src/wallets/schemas/transfer.schema';
import { Wallet } from '../../src/wallets/schemas/wallet.schema';
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
});
