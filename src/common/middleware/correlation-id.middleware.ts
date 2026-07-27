import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CorrelationIdService } from '../correlation-id.service';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly correlationIds: CorrelationIdService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const supplied = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof supplied === 'string' && supplied.trim()
        ? supplied.trim()
        : this.correlationIds.getOrCreate();
    (req as any).correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    this.correlationIds.run(correlationId, next);
  }
}
