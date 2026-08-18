import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import type { Database } from '../database/database.module';
import { appointments, users } from '../database/schema';
import { DoctorsService } from '../doctors/doctors.service';
import {
  REMINDER_JOB,
  REMINDER_LEAD_MS,
  REMINDERS_QUEUE,
  reminderJobId,
  ReminderJobData,
} from '../jobs/reminders.constants';
import { BookDto } from './dto/book.dto';
import { resolveBookableSlot } from './booking';

export const CANCEL_WINDOW_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly doctors: DoctorsService,
    @InjectQueue(REMINDERS_QUEUE) private readonly reminders: Queue<ReminderJobData>,
  ) {}

  async book(patientId: number, dto: BookDto) {
    const [doctor] = await this.db
      .select({ id: users.id, slotDurationMin: users.slotDurationMin })
      .from(users)
      .where(eq(users.id, dto.doctorId))
      .limit(1);
    if (!doctor) throw new NotFoundException('Doctor not found');

    // Early validation for 400s only; the DB guard below is the authority.
    // Uses the grid minus blocks (bookings ignored) so an already-taken but
    // legitimate slot flows to the guard and returns 409, not 400.
    const day = new Date(dto.startTime).toISOString().slice(0, 10);
    const available = await this.doctors.getSchedulableSlots(dto.doctorId, day, day);
    const target = resolveBookableSlot(dto.startTime, available, doctor.slotDurationMin);
    if (!target) throw new BadRequestException('Slot is not available');

    const [appointment] = await this.db
      .insert(appointments)
      .values({
        doctorId: dto.doctorId,
        patientId,
        startTime: new Date(target.start),
        endTime: new Date(target.end),
      })
      .onConflictDoNothing()
      .returning();
    if (!appointment) throw new ConflictException('Slot already taken');

    await this.scheduleReminder(appointment);
    return appointment;
  }

  private async scheduleReminder(appointment: {
    id: number;
    doctorId: number;
    startTime: Date;
  }) {
    const delayMs = Math.max(
      0,
      new Date(appointment.startTime).getTime() - Date.now() - REMINDER_LEAD_MS,
    );
    try {
      await this.reminders.add(
        REMINDER_JOB,
        {
          appointmentId: appointment.id,
          doctorId: appointment.doctorId,
          startTime: appointment.startTime.toISOString(),
        },
        {
          jobId: reminderJobId(appointment.id),
          delay: delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
        },
      );
    } catch (err) {
      // Booking is primary; a queue outage must not fail an accepted booking.
      this.logger.error(
        `failed to enqueue reminder for appointment ${appointment.id}: ${
          (err as Error).message ?? err
        }`,
      );
    }
  }

  async mine(patientId: number) {
    return this.db
      .select()
      .from(appointments)
      .where(eq(appointments.patientId, patientId))
      .orderBy(asc(appointments.startTime));
  }

  async cancel(patientId: number, appointmentId: number) {
    const [appointment] = await this.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, appointmentId), eq(appointments.patientId, patientId)))
      .limit(1);
    if (!appointment) throw new NotFoundException('Appointment not found');
    if (appointment.status !== 'scheduled') {
      throw new ConflictException('Appointment is no longer active');
    }

    if (new Date(appointment.startTime).getTime() - Date.now() < CANCEL_WINDOW_MS) {
      throw new UnprocessableEntityException(
        'Cannot cancel within 2 hours of the appointment start',
      );
    }

    const [cancelled] = await this.db
      .update(appointments)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.patientId, patientId),
          eq(appointments.status, 'scheduled'),
        ),
      )
      .returning();

    try {
      await this.reminders.remove(reminderJobId(appointmentId));
    } catch (err) {
      this.logger.error(`failed to remove reminder for appointment ${appointmentId}`, err);
    }

    return cancelled!;
  }
}