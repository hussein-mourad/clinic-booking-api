import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { WAITLIST_QUEUE } from '../waitlist/waitlist.constants';
import { REMINDERS_QUEUE } from './reminders.constants';
import { RemindersProcessor } from './reminders.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: Number(config.get('REDIS_PORT', '6379')),
          maxRetriesPerRequest: null,
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: REMINDERS_QUEUE }, { name: WAITLIST_QUEUE }),
  ],
  providers: [RemindersProcessor],
  exports: [BullModule],
})
export class JobsModule {}