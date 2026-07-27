import { CorrelationIdService } from './correlation-id.service';

describe('CorrelationIdService', () => {
  it('preserves isolated correlation ids across concurrent asynchronous work', async () => {
    const service = new CorrelationIdService();

    const [first, second] = await Promise.all([
      service.run('request-1', async () => {
        await Promise.resolve();
        return service.get();
      }),
      service.run('request-2', async () => {
        await Promise.resolve();
        return service.get();
      }),
    ]);

    expect(first).toBe('request-1');
    expect(second).toBe('request-2');
    expect(service.get()).toBeUndefined();
  });
});
