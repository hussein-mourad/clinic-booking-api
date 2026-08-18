import { Module } from '@nestjs/common';
import { DoctorsModule } from '../doctors/doctors.module';
import { JobsModule } from '../jobs/jobs.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

@Module({
  imports: [DoctorsModule, JobsModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}