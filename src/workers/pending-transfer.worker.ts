import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { OutboxService } from '../outbox/outbox.service';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';

@Injectable()
export class PendingTransferWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingTransferWorker.name);
  private timer: NodeJS.Timeout;
  private currentSweep?: Promise<void>;
  private stopping = false;

  constructor(
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.getOrThrow<number>(
      'workers.pendingTransferSweepIntervalMs',
    );
    this.timer = setInterval(() => {
      if (this.stopping || this.currentSweep) return;

      this.currentSweep = this.sweep()
        .catch((error) => {
          this.logger.error(`Pending transfer recovery failed: ${(error as Error).message}`);
        })
        .finally(() => {
          this.currentSweep = undefined;
        });
    }, intervalMs);
  }

  async sweep() {
    const timeoutMs = this.configService.getOrThrow<number>('workers.pendingTransferTimeoutMs');
    const recoveryIntervalMs = this.configService.getOrThrow<number>(
      'workers.pendingTransferRecoveryIntervalMs',
    );
    const maxAttempts = this.configService.getOrThrow<number>(
      'workers.pendingTransferMaxRecoveryAttempts',
    );
    const cutoff = new Date(Date.now() - timeoutMs);

    let recovered = 0;
    while (!this.stopping && recovered < 50) {
      const transfer = await this.enqueueRecovery(cutoff, recoveryIntervalMs, maxAttempts);
      if (!transfer) break;
      recovered += 1;
    }

    if (recovered > 0) {
      this.logger.warn(`Enqueued recovery for ${recovered} stale transfer(s)`);
    }

    const exhausted = await this.transferModel.updateMany(
      {
        status: TransferStatus.PENDING,
        createdAt: { $lt: cutoff },
        recoveryAttempts: { $gte: maxAttempts },
        nextRecoveryAt: { $lte: new Date() },
        failureReason: { $ne: 'Recovery attempts exhausted; manual review required' },
      },
      { $set: { failureReason: 'Recovery attempts exhausted; manual review required' } },
    );
    if (exhausted.modifiedCount > 0) {
      this.logger.error(
        `${exhausted.modifiedCount} transfer(s) exhausted recovery attempts and require manual review`,
      );
    }
  }

  private async enqueueRecovery(cutoff: Date, recoveryIntervalMs: number, maxAttempts: number) {
    const session = await this.connection.startSession();
    let claimed: TransferDocument | null = null;

    try {
      await session.withTransaction(async () => {
        const now = new Date();
        claimed = await this.transferModel.findOneAndUpdate(
          {
            status: TransferStatus.PENDING,
            createdAt: { $lt: cutoff },
            $and: [
              {
                $or: [
                  { recoveryAttempts: { $exists: false } },
                  { recoveryAttempts: { $lt: maxAttempts } },
                ],
              },
              {
                $or: [{ nextRecoveryAt: { $exists: false } }, { nextRecoveryAt: { $lte: now } }],
              },
            ],
          },
          {
            $inc: { recoveryAttempts: 1 },
            $set: { nextRecoveryAt: new Date(now.getTime() + recoveryIntervalMs) },
            $unset: { failureReason: 1 },
          },
          { new: true, session, sort: { createdAt: 1 } },
        );

        if (!claimed) return;

        await this.outboxService.enqueue(
          'transfer.initiated',
          {
            transferId: claimed._id.toString(),
            fromWalletId: claimed.fromWalletId.toString(),
            toWalletId: claimed.toWalletId.toString(),
            amount: claimed.amount,
            recoveryAttempt: claimed.recoveryAttempts,
          },
          session,
        );
      });
      return claimed;
    } finally {
      await session.endSession();
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.currentSweep;
  }
}
