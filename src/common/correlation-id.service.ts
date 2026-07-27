import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CorrelationIdService {
  private readonly storage = new AsyncLocalStorage<string>();

  run<T>(correlationId: string, callback: () => T): T {
    return this.storage.run(correlationId, callback);
  }

  get(): string | undefined {
    return this.storage.getStore();
  }

  getOrCreate(): string {
    return this.get() ?? uuidv4();
  }

  format(): string {
    return `[correlationId=${this.getOrCreate()}]`;
  }
}
