import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { Transfer, TransferStatus } from '../../src/wallets/schemas/transfer.schema';
import { Wallet } from '../../src/wallets/schemas/wallet.schema';
import { createAuthenticatedRequest, createTestApp, getModel, resetDatabase } from './test-utils';

async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('Concurrent wallet operations (integration)', () => {
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

  it('never lets a wallet balance go negative under concurrent withdrawals', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'concurrent-1', ownerName: 'Akosua Darko' })
      .expect(201);

    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 100 }).expect(201);

    const concurrentWithdrawals = 10;
    const results = await Promise.allSettled(
      Array.from({ length: concurrentWithdrawals }, () =>
        client.post(`/wallets/${wallet.body._id}/withdraw`).send({ amount: 20 }),
      ),
    );

    const finalWallet = await getModel(app, Wallet.name).findById(wallet.body._id);

    expect(finalWallet?.balance).toBeGreaterThanOrEqual(0);

    const successfulWithdrawals = results.filter(
      (result) => result.status === 'fulfilled' && (result.value as any).status === 201,
    ).length;
    expect(finalWallet?.balance).toBe(100 - successfulWithdrawals * 20);
  });

  it('never lets concurrent transfers spend more than the sender balance', async () => {
    const sender = await client
      .post('/wallets')
      .send({ userId: 'concurrent-sender', ownerName: 'Concurrent Sender' })
      .expect(201);
    const receiver = await client
      .post('/wallets')
      .send({ userId: 'concurrent-receiver', ownerName: 'Concurrent Receiver' })
      .expect(201);
    await client.post(`/wallets/${sender.body._id}/deposit`).send({ amount: 100 }).expect(201);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        client.post('/wallets/transfer').send({
          fromWalletId: sender.body._id,
          toWalletId: receiver.body._id,
          amount: 20,
          idempotencyKey: `concurrent-transfer-${index}`,
        }),
      ),
    );
    const successfulTransfers = responses.filter((response) => response.status === 201).length;
    const finalSender = await getModel(app, Wallet.name).findById(sender.body._id);
    const allSettled = await pollUntil(async () => {
      const completed = await getModel(app, Transfer.name).countDocuments({
        status: TransferStatus.COMPLETED,
      });
      return completed === successfulTransfers;
    });
    const finalReceiver = await getModel(app, Wallet.name).findById(receiver.body._id);

    expect(finalSender?.balance).toBeGreaterThanOrEqual(0);
    expect(finalSender?.balance).toBe(100 - successfulTransfers * 20);
    expect(allSettled).toBe(true);
    expect(finalReceiver?.balance).toBe(successfulTransfers * 20);
  });
});
