import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Inject, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DRIZZLE, Database } from '../database/database.module';
import { Public } from '../auth/public.decorator';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) { }

  async check() {
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: 'ok', database: 'up' };
    } catch (err) {
      this.logger.error('Database health check failed', err);
      return { status: 'degraded', database: 'down' };
    }
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  check() {
    return this.health.check();
  }
}

@Module({
  providers: [HealthService],
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule { }
