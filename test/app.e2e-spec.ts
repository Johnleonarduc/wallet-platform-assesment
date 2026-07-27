import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET) reports service status without requiring auth headers', () => {
    return request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'health-check-correlation')
      .expect(200)
      .expect((res) => {
        expect(res.headers['x-correlation-id']).toBe('health-check-correlation');
        expect(res.body).toHaveProperty('status');
        expect(res.body).toHaveProperty('mongo');
        expect(res.body).toHaveProperty('redis');
      });
  });

  it('rejects requests to protected routes without a bearer token', () => {
    return request(app.getHttpServer()).get('/transactions').expect(401);
  });
});
