import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { CorrelationIdService } from '../common/correlation-id.service';
import { OutboxEvent, OutboxEventDocument, OutboxEventStatus } from './schemas/outbox-event.schema';

@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(OutboxEvent.name) private readonly outboxModel: Model<OutboxEventDocument>,
    private readonly correlationIds: CorrelationIdService,
  ) {}

  async enqueue(routingKey: string, payload: Record<string, unknown>, session?: ClientSession) {
    const [event] = await this.outboxModel.create(
      [
        {
          routingKey,
          payload: { ...payload, correlationId: this.correlationIds.getOrCreate() },
          status: OutboxEventStatus.PENDING,
        },
      ],
      session ? { session } : undefined,
    );
    return event;
  }

  async findPending(limit: number) {
    return this.outboxModel
      .find({ status: OutboxEventStatus.PENDING })
      .sort({ createdAt: 1 })
      .limit(limit)
      .exec();
  }

  async markPublished(id: string) {
    await this.outboxModel.updateOne(
      { _id: id },
      { status: OutboxEventStatus.PUBLISHED, publishedAt: new Date() },
    );
  }
}
