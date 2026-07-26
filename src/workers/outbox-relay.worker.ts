import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    try {
      const pending = await this.outboxService.findPending(50);
      for (const event of pending) {
        await this.rabbitMQService.publish(event.routingKey, event.payload);
        await this.outboxService.markPublished(event.id);
      }
    } catch (error) {
      this.logger.error(`Outbox relay failed: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.currentRelay;
  }
}
