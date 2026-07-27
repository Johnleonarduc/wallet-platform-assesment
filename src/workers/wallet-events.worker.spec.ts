import { Types } from 'mongoose';
import { WALLET_SNAPSHOT_EVENT, walletEventBus, WalletEventsWorker } from './wallet-events.worker';

describe('WalletEventsWorker', () => {
  afterEach(() => {
    jest.useRealTimers();
    walletEventBus.removeAllListeners(WALLET_SNAPSHOT_EVENT);
  });

  function createWorker(exec: jest.Mock) {
    const query = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec,
    };
    const walletModel = { find: jest.fn().mockReturnValue(query) } as any;
    return { worker: new WalletEventsWorker(walletModel), walletModel, query };
  }

  it('keeps one listener while repeated ticks emit wallet snapshots', async () => {
    jest.useFakeTimers();
    const exec = jest.fn().mockResolvedValue([{ _id: new Types.ObjectId(), balance: 25 }]);
    const { worker, query } = createWorker(exec);

    worker.onModuleInit();
    expect(walletEventBus.listenerCount(WALLET_SNAPSHOT_EVENT)).toBe(1);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(query.select).toHaveBeenCalledWith({ _id: 1, balance: 1 });
    expect(query.lean).toHaveBeenCalledTimes(3);
    expect(walletEventBus.listenerCount(WALLET_SNAPSHOT_EVENT)).toBe(1);

    await worker.onModuleDestroy();
    expect(walletEventBus.listenerCount(WALLET_SNAPSHOT_EVENT)).toBe(0);
  });

  it('does not overlap ticks and waits for an active tick during shutdown', async () => {
    jest.useFakeTimers();
    let resolveTick!: (wallets: never[]) => void;
    const pendingTick = new Promise<never[]>((resolve) => {
      resolveTick = resolve;
    });
    const exec = jest.fn().mockReturnValue(pendingTick);
    const { worker } = createWorker(exec);

    worker.onModuleInit();
    jest.advanceTimersByTime(30_000);
    expect(exec).toHaveBeenCalledTimes(1);

    let shutdownComplete = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    expect(walletEventBus.listenerCount(WALLET_SNAPSHOT_EVENT)).toBe(0);

    resolveTick([]);
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });
});
