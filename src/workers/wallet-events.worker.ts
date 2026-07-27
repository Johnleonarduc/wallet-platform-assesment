import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter } from 'events';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';

export const walletEventBus = new EventEmitter();
export const WALLET_SNAPSHOT_EVENT = 'wallet.snapshot';

interface WalletSnapshot {
  walletId: string;
  balance: number;
}

/**
 * Watches wallets whose balance recently changed and logs a snapshot for
 * downstream monitoring dashboards. Ticks on a fixed interval.
 */
@Injectable()
export class WalletEventsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletEventsWorker.name);
  private timer: NodeJS.Timeout;
  private currentTick?: Promise<void>;
  private stopping = false;
  private readonly handleSnapshot = ({ walletId, balance }: WalletSnapshot) => {
    this.logger.debug(`Wallet ${walletId} snapshot balance=${balance}`);
  };

  constructor(@InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>) {}

  onModuleInit() {
    walletEventBus.on(WALLET_SNAPSHOT_EVENT, this.handleSnapshot);
    this.timer = setInterval(() => {
      if (this.stopping || this.currentTick) return;

      this.currentTick = this.tick()
        .catch((error) => {
          this.logger.error(`Wallet snapshot tick failed: ${(error as Error).message}`);
        })
        .finally(() => {
          this.currentTick = undefined;
        });
    }, 10_000);
  }

  private async tick() {
    const recentWallets = await this.walletModel
      .find()
      .select({ _id: 1, balance: 1 })
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean()
      .exec();

    for (const wallet of recentWallets) {
      walletEventBus.emit(WALLET_SNAPSHOT_EVENT, {
        walletId: wallet._id.toString(),
        balance: wallet.balance,
      } satisfies WalletSnapshot);
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    walletEventBus.removeListener(WALLET_SNAPSHOT_EVENT, this.handleSnapshot);
    await this.currentTick;
  }
}
