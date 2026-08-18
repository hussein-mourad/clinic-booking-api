import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import type { Database } from '../database/database.module';
import { appointments, notifications, users, waitingList } from '../database/schema';
import { DoctorsService } from '../doctors/doctors.service';
import { resolveBookableSlot } from '../appointments/booking';
import { JoinWaitlistDto } from './dto/join-waitlist.dto';
import {
  OFFER_VALID_MS,
  SWEEP_INTERVAL_MS,
  WAITLIST_QUEUE,
  WAITLIST_SWEEP_JOB,
  WAITLIST_SWEEP_SCHEDULER,
} from './waitlist.constants';

@Injectable()
export class WaitlistService implements OnModuleInit {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly doctors: DoctorsService,
    @InjectQueue(WAITLIST_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    // Idempotent scheduler registration: expire stale offers, then recurse to
    // the next FIFO candidate for each freed slot.
    await this.queue.upsertJobScheduler(
      WAITLIST_SWEEP_SCHEDULER,
      { every: SWEEP_INTERVAL_MS },
      { name: WAITLIST_SWEEP_JOB },
    );
  }

  async join(patientId: number, dto: JoinWaitlistDto) {
    const [doctor] = await this.db
      .select({ id: users.id, slotDurationMin: users.slotDurationMin })
      .from(users)
      .where(eq(users.id, dto.doctorId))
      .limit(1);
    if (!doctor) throw new NotFoundException('Doctor not found');

    const day = new Date(dto.startTime).toISOString().slice(0, 10);
    const grid = await this.doctors.getSchedulableSlots(dto.doctorId, day, day);
    if (!resolveBookableSlot(dto.startTime, grid, doctor.slotDurationMin)) {
      throw new BadRequestException('Slot is not bookable');
    }

    const slotStart = new Date(dto.startTime);
    const [existing] = await this.db
      .select({ id: waitingList.id })
      .from(waitingList)
      .where(
        and(
          eq(waitingList.patientId, patientId),
          eq(waitingList.doctorId, dto.doctorId),
          eq(waitingList.slotStart, slotStart),
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException('Already on the waiting list for this slot');

    const [{ maxPosition }] = await this.db
      .select({ maxPosition: sql<number>`coalesce(max(${waitingList.position}), 0)` })
      .from(waitingList)
      .where(and(eq(waitingList.doctorId, dto.doctorId), eq(waitingList.slotStart, slotStart)));

    const [row] = await this.db
      .insert(waitingList)
      .values({
        doctorId: dto.doctorId,
        patientId,
        slotStart,
        position: (maxPosition ?? 0) + 1,
        status: 'waiting',
      })
      .returning();
    return row!;
  }

  async leave(patientId: number, id: number) {
    const [row] = await this.db
      .select()
      .from(waitingList)
      .where(and(eq(waitingList.id, id), eq(waitingList.patientId, patientId)))
      .limit(1);
    if (!row) throw new NotFoundException('Waiting-list entry not found');
    if (row.status !== 'waiting' && row.status !== 'offered') {
      throw new ConflictException('Entry is no longer withdrawable');
    }
    await this.db.delete(waitingList).where(eq(waitingList.id, row.id));
    return { deleted: true };
  }

  async accept(patientId: number, id: number) {
    const [row] = await this.db
      .select()
      .from(waitingList)
      .where(and(eq(waitingList.id, id), eq(waitingList.patientId, patientId)))
      .limit(1);
    if (!row) throw new NotFoundException('Waiting-list entry not found');
    if (row.status !== 'offered') {
      throw new ConflictException('No active offer on this entry');
    }
    if (new Date(row.offerExpiresAt!).getTime() < Date.now()) {
      throw new ConflictException('Offer expired');
    }

    const [doctor] = await this.db
      .select({ id: users.id, slotDurationMin: users.slotDurationMin })
      .from(users)
      .where(eq(users.id, row.doctorId))
      .limit(1);
    if (!doctor) throw new NotFoundException('Doctor not found');
    const start = new Date(row.slotStart);
    const end = new Date(start.getTime() + doctor.slotDurationMin * 60_000);

    let appointment;
    await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(appointments)
        .values({
          doctorId: row.doctorId,
          patientId,
          startTime: start,
          endTime: end,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new ConflictException('Slot was taken before the offer');
      appointment = created;
      await tx
        .update(waitingList)
        .set({ status: 'accepted' })
        .where(and(eq(waitingList.id, row.id), eq(waitingList.patientId, patientId)));
      await tx.insert(notifications).values({
        userId: patientId,
        type: 'waitlist_confirmation',
        payload: {
          appointmentId: created.id,
          doctorId: row.doctorId,
          slotStart: row.slotStart.toISOString(),
        },
      });
    });

    return appointment;
  }

  /** @returns the patient offered the slot, or null when nobody is next. */
  async claimNext(doctorId: number, slotStart: Date): Promise<number | null> {
    const result = await this.db.execute<{ id: number; patient_id: number }>(sql`
      UPDATE waiting_list w
      SET status = 'offered', offered_at = now(), offer_expires_at = now() + interval '15 minutes'
      FROM (
        SELECT id
        FROM waiting_list
        WHERE doctor_id = ${doctorId}
          AND slot_start = ${slotStart}
          AND status = 'waiting'
          AND NOT EXISTS (
            SELECT 1 FROM waiting_list o
            WHERE o.doctor_id = ${doctorId}
              AND o.slot_start = ${slotStart}
              AND o.status = 'offered'
          )
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.doctor_id = ${doctorId}
              AND a.start_time = ${slotStart}
              AND a.status = 'scheduled'
          )
        ORDER BY position ASC, created_at ASC
        LIMIT 1
      ) c
      WHERE w.id = c.id AND w.status = 'waiting'
      RETURNING w.id, w.patient_id
    `);

    if (result.rowCount !== 1) return null;
    const patientId = result.rows[0]!.patient_id;
    await this.db.insert(notifications).values({
      userId: patientId,
      type: 'waitlist_offer',
      payload: {
        doctorId,
        slotStart: slotStart.toISOString(),
        offeredAt: new Date().toISOString(),
        offerExpiresAt: new Date(Date.now() + OFFER_VALID_MS).toISOString(),
      },
    });
    this.logger.log(`waitlist: offered ${slotStart.toISOString()} to patient ${patientId}`);
    return patientId;
  }

  /** Expire stale offers, then recurse to the next FIFO candidate per slot. */
  async sweep() {
    const expired = await this.db
      .select()
      .from(waitingList)
      .where(and(eq(waitingList.status, 'offered'), lt(waitingList.offerExpiresAt, new Date())));
    for (const row of expired) {
      const [updated] = await this.db
        .update(waitingList)
        .set({ status: 'expired' })
        .where(and(eq(waitingList.id, row.id), eq(waitingList.status, 'offered')))
        .returning({ id: waitingList.id });
      if (updated) {
        await this.claimNext(row.doctorId, new Date(row.slotStart));
      }
    }
  }
}