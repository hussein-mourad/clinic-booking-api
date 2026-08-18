import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { WaitlistService } from './waitlist.service';
import {
  WAITLIST_PROCESS_JOB,
  WAITLIST_QUEUE,
  WAITLIST_SWEEP_JOB,
  type WaitlistProcessData,
} from './waitlist.constants';

@Injectable()
@Processor(WAITLIST_QUEUE, { concurrency: 5 })
export class WaitlistProcessor extends WorkerHost {
  constructor(private readonly waitlist: WaitlistService) {
    super();
  }

  async process(job: Job<WaitlistProcessData>) {
    if (job.name === WAITLIST_SWEEP_JOB) {
      await this.waitlist.sweep();
      return;
    }
    if (job.name === WAITLIST_PROCESS_JOB) {
      await this.waitlist.claimNext(job.data.doctorId, new Date(job.data.slotStart));
    }
  }
}