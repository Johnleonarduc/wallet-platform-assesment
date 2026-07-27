import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import { ChannelWrapper } from 'amqp-connection-manager';
import { ConfirmChannel } from 'amqplib';
import { CorrelationIdService } from '../common/correlation-id.service';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqp.AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;
  private readonly exchange: string;
  private readonly transferQueue: string;
  private stopping = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly correlationIds: CorrelationIdService,
  ) {
    this.exchange = this.configService.getOrThrow<string>('rabbitmq.exchange');
    this.transferQueue = this.configService.getOrThrow<string>('rabbitmq.transferQueue');
  }

  async onModuleInit() {
    const uri = this.configService.getOrThrow<string>('rabbitmq.uri');
    this.connection = amqp.connect([uri]);
    this.connection.on('connectFailed', (err) =>
      this.logger.error(`RabbitMQ connection failed: ${err?.err?.message}`),
    );

    this.channelWrapper = this.connection.createChannel({
      json: true,
      setup: (channel: ConfirmChannel) =>
        Promise.all([
          channel.assertExchange(this.exchange, 'topic', { durable: true }),
          channel.assertQueue(this.transferQueue, { durable: true }),
          channel.bindQueue(this.transferQueue, this.exchange, 'transfer.*'),
        ]),
    });
    this.channelWrapper.on('error', (error) => {
      if (!this.stopping) {
        this.logger.error(`RabbitMQ channel error: ${(error as Error).message}`);
      }
    });
  }

  async publish(routingKey: string, payload: Record<string, unknown>): Promise<void> {
    const correlationId =
      typeof payload.correlationId === 'string'
        ? payload.correlationId
        : this.correlationIds.getOrCreate();
    await this.channelWrapper.publish(this.exchange, routingKey, payload, {
      persistent: true,
      correlationId,
    });
    this.logger.log(`[correlationId=${correlationId}] Published event ${routingKey}`);
  }

  getChannelWrapper(): ChannelWrapper {
    return this.channelWrapper;
  }

  getTransferQueue(): string {
    return this.transferQueue;
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.channelWrapper?.close();
    await this.connection?.close();
  }
}
