import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WaitlistService } from './waitlist.service';
import { logJobRun } from '../jobs/job-run.helper';
import {
  WAITLIST_PROCESS_JOB,
  WAITLIST_QUEUE,
  WAITLIST_SWEEP_JOB,
  type WaitlistProcessData,
} from './waitlist.constants';

@Injectable()
@Processor(WAITLIST_QUEUE, { concurrency: 5 })
export class WaitlistProcessor extends WorkerHost {
  private readonly logger = new Logger(WaitlistProcessor.name);

  constructor(private readonly waitlist: WaitlistService) {
    super();
  }

  async process(job: Job<WaitlistProcessData>) {
    if (job.name === WAITLIST_SWEEP_JOB) {
      logJobRun(this.logger, WAITLIST_QUEUE, job, 'start (sweep)');
      const expired = await this.waitlist.sweep();
      logJobRun(this.logger, WAITLIST_QUEUE, job, 'sweep done', { expiredCount: expired });
      return;
    }
    if (job.name === WAITLIST_PROCESS_JOB) {
      logJobRun(this.logger, WAITLIST_QUEUE, job, 'start (claim)', {
        doctorId: job.data.doctorId,
        slotStart: job.data.slotStart,
      });
      const offered = await this.waitlist.claimNext(job.data.doctorId, new Date(job.data.slotStart));
      logJobRun(this.logger, WAITLIST_QUEUE, job, offered ? 'offered' : 'no candidate', {
        doctorId: job.data.doctorId,
        slotStart: job.data.slotStart,
        patientId: offered,
      });
    }
  }
}