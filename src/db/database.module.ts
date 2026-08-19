import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { createDb, Database } from './index';

export const DRIZZLE = 'DRIZZLE';
export const DATABASE_POOL = 'DATABASE_POOL';

export type { Database };

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
        }),
    },
    {
      provide: DRIZZLE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): Database => createDb(pool),
    },
  ],
  exports: [DRIZZLE, DATABASE_POOL],
})
export class DatabaseModule {}