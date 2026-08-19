import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DATABASE_POOL } from '../src/db/database.module';

describe('App (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await (app.get(DATABASE_POOL) as Pool).end();
    await app.close();
  });

  it('/health (GET) returns ok with database up and an instance id', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(typeof res.body.instance).toBe('string');
  });
});
