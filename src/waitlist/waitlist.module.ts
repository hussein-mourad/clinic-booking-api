import { Module } from '@nestjs/common';
import { DoctorsModule } from '../doctors/doctors.module';
import { JobsModule } from '../jobs/jobs.module';
import { WaitlistController } from './waitlist.controller';
import { WaitlistProcessor } from './waitlist.processor';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [JobsModule, DoctorsModule],
  controllers: [WaitlistController],
  providers: [WaitlistService, WaitlistProcessor],
  exports: [WaitlistService],
})
export class WaitlistModule {}
