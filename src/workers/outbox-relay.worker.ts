import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CorrelationIdService } from '../common/correlation-id.service';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';

@Injectable()
export class OutboxRelayWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private timer: NodeJS.Timeout;
  private currentRelay?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly outboxService: OutboxService,
    private readonly rabbitMQService: RabbitMQService,
    private readonly configService: ConfigService,
    private readonly correlationIds: CorrelationIdService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.getOrThrow<number>('workers.outboxRelayIntervalMs');
    this.timer = setInterval(() => {
      if (this.stopping || this.currentRelay) {
        return;
      }

      this.currentRelay = this.relay().finally(() => {
        this.currentRelay = undefined;
      });
    }, intervalMs);
  }

  private async relay() {
    let activeCorrelationId = this.correlationIds.getOrCreate();
    try {
      const pending = await this.outboxService.findPending(50);
      for (const event of pending) {
        activeCorrelationId =
          typeof event.payload.correlationId === 'string'
            ? event.payload.correlationId
            : this.correlationIds.getOrCreate();
        await this.correlationIds.run(activeCorrelationId, async () => {
          await this.rabbitMQService.publish(event.routingKey, event.payload);
          await this.outboxService.markPublished(event.id);
        });
      }
    } catch (error) {
      this.logger.error(
        `[correlationId=${activeCorrelationId}] Outbox relay failed: ${(error as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.currentRelay;
  }
}
