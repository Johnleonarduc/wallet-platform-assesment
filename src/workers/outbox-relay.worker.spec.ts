import { ConfigService } from '@nestjs/config';
import { CorrelationIdService } from '../common/correlation-id.service';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { OutboxRelayWorker } from './outbox-relay.worker';

describe('OutboxRelayWorker', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for an active relay before completing shutdown', async () => {
    jest.useFakeTimers();

    let resolvePending!: (events: never[]) => void;
    const pendingEvents = new Promise<never[]>((resolve) => {
      resolvePending = resolve;
    });
    const outboxService = {
      findPending: jest.fn().mockReturnValue(pendingEvents),
      markPublished: jest.fn(),
    } as unknown as OutboxService;
    const rabbitMQService = {
      publish: jest.fn(),
    } as unknown as RabbitMQService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(10),
    } as unknown as ConfigService;
    const worker = new OutboxRelayWorker(
      outboxService,
      rabbitMQService,
      configService,
      new CorrelationIdService(),
    );

    worker.onModuleInit();
    jest.advanceTimersByTime(10);

    let shutdownCompleted = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();

    expect(outboxService.findPending).toHaveBeenCalledTimes(1);
    expect(shutdownCompleted).toBe(false);

    resolvePending([]);
    await shutdown;

    expect(shutdownCompleted).toBe(true);
    jest.advanceTimersByTime(20);
    expect(outboxService.findPending).toHaveBeenCalledTimes(1);
  });
});
