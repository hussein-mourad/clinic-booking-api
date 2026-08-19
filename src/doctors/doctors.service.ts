import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import type { Database } from '../database/database.module';
import { appointments, blockedSlots, schedules, users } from '../database/schema';
import { generateSlots } from './slots.generator';
import { CreateBlockDto } from './dto/create-block.dto';
import { UpdateBlockDto } from './dto/update-block.dto';
import { ScheduleEntryDto } from './dto/schedule-entry.dto';

export const SLOT_DURATION_OPTIONS = [15, 30, 60] as const;

const toHHMM = (t: string | null): string | null => (t ? t.slice(0, 5) : t);

const MAX_SLOT_RANGE_DAYS = 90;

@Injectable()
export class DoctorsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listDoctors() {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        slotDurationMin: users.slotDurationMin,
      })
      .from(users)
      .where(eq(users.role, 'doctor'))
      .orderBy(users.name);
  }

  async replaceSchedule(doctorId: number, entries: ScheduleEntryDto[]) {
    const seen = new Set<number>();
    for (const entry of entries) {
      if (seen.has(entry.dayOfWeek)) {
        throw new BadRequestException(`Duplicate dayOfWeek ${entry.dayOfWeek}`);
      }
      seen.add(entry.dayOfWeek);
      if (entry.startTime >= entry.endTime) {
        throw new BadRequestException(
          `startTime must be before endTime on dayOfWeek ${entry.dayOfWeek}`,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(schedules).where(eq(schedules.doctorId, doctorId));
      if (entries.length > 0) {
        await tx.insert(schedules).values(
          entries.map((entry) => ({
            doctorId,
            dayOfWeek: entry.dayOfWeek,
            startTime: entry.startTime,
            endTime: entry.endTime,
          })),
        );
      }
    });

    return this.getSchedule(doctorId);
  }

  async getSchedule(doctorId: number) {
    const rows = await this.db
      .select()
      .from(schedules)
      .where(eq(schedules.doctorId, doctorId))
      .orderBy(schedules.dayOfWeek);
    return rows.map((row) => ({
      ...row,
      startTime: toHHMM(row.startTime),
      endTime: toHHMM(row.endTime),
    }));
  }

  async getScheduleForDoctor(doctorId: number) {
    const [doctor] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (!doctor) throw new NotFoundException('Doctor not found');
    return this.getSchedule(doctorId);
  }

  async getProfile(doctorId: number) {
    const [row] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        slotDurationMin: users.slotDurationMin,
      })
      .from(users)
      .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (!row) throw new NotFoundException('Doctor not found');
    return row;
  }

  async listAppointments(doctorId: number, from?: string, to?: string) {
    return this.db
      .select({
        id: appointments.id,
        patientId: appointments.patientId,
        patientName: users.name,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        createdAt: appointments.createdAt,
        cancelledAt: appointments.cancelledAt,
      })
      .from(appointments)
      .innerJoin(users, eq(users.id, appointments.patientId))
      .where(
        and(
          eq(appointments.doctorId, doctorId),
          from ? gte(appointments.startTime, new Date(`${from}T00:00:00Z`)) : undefined,
          to ? lte(appointments.startTime, new Date(`${to}T23:59:59.999Z`)) : undefined,
        ),
      )
      .orderBy(asc(appointments.startTime));
  }

  async addBlock(doctorId: number, dto: CreateBlockDto) {
    const hasStart = dto.startTime !== undefined;
    const hasEnd = dto.endTime !== undefined;
    if (hasStart !== hasEnd) {
      throw new BadRequestException('Provide both startTime and endTime, or neither for a full-day block');
    }
    if (hasStart && dto.startTime! >= dto.endTime!) {
      throw new BadRequestException('startTime must be before endTime');
    }

    const [row] = await this.db
      .insert(blockedSlots)
      .values({
        doctorId,
        blockDate: dto.blockDate,
        startTime: dto.startTime,
        endTime: dto.endTime,
      })
      .returning();
    return {
      ...row,
      startTime: toHHMM(row.startTime),
      endTime: toHHMM(row.endTime),
    };
  }

  async removeBlock(doctorId: number, blockId: number) {
    const result = await this.db
      .delete(blockedSlots)
      .where(and(eq(blockedSlots.id, blockId), eq(blockedSlots.doctorId, doctorId)));
    if (result.rowCount === 0) {
      throw new NotFoundException('Block not found');
    }
  }

  async listBlocks(doctorId: number) {
    const rows = await this.db
      .select()
      .from(blockedSlots)
      .where(eq(blockedSlots.doctorId, doctorId))
      .orderBy(blockedSlots.blockDate, blockedSlots.startTime);
    return rows.map((row) => ({
      ...row,
      startTime: toHHMM(row.startTime),
      endTime: toHHMM(row.endTime),
    }));
  }

  async getBlock(doctorId: number, blockId: number) {
    const [row] = await this.db
      .select()
      .from(blockedSlots)
      .where(and(eq(blockedSlots.id, blockId), eq(blockedSlots.doctorId, doctorId)))
      .limit(1);
    if (!row) throw new NotFoundException('Block not found');
    return {
      ...row,
      startTime: toHHMM(row.startTime),
      endTime: toHHMM(row.endTime),
    };
  }

  async updateBlock(doctorId: number, blockId: number, dto: UpdateBlockDto) {
    const hasStart = dto.startTime !== undefined;
    const hasEnd = dto.endTime !== undefined;
    if (hasStart !== hasEnd) {
      throw new BadRequestException('Provide both startTime and endTime, or neither for a full-day block');
    }
    if (hasStart && dto.startTime! >= dto.endTime!) {
      throw new BadRequestException('startTime must be before endTime');
    }

    const result = await this.db
      .update(blockedSlots)
      .set({
        ...(dto.blockDate !== undefined ? { blockDate: dto.blockDate } : {}),
        ...(dto.startTime !== undefined ? { startTime: dto.startTime } : {}),
        ...(dto.endTime !== undefined ? { endTime: dto.endTime } : {}),
      })
      .where(and(eq(blockedSlots.id, blockId), eq(blockedSlots.doctorId, doctorId)))
      .returning();
    if (result.length === 0) {
      throw new NotFoundException('Block not found');
    }
    return {
      ...result[0],
      startTime: toHHMM(result[0].startTime),
      endTime: toHHMM(result[0].endTime),
    };
  }

  async setSlotDuration(doctorId: number, slotDurationMin: number) {
    const result = await this.db
      .update(users)
      .set({ slotDurationMin })
      .where(eq(users.id, doctorId));
    if (result.rowCount === 0) {
      throw new NotFoundException('Doctor not found');
    }
  }

  async getAvailableSlots(doctorId: number, from: string, to: string) {
    this.assertRange(from, to);
    const source = await this.loadSlotSource(doctorId, from, to);
    return generateSlots({
      schedule: source.schedule,
      blocks: source.blocks,
      bookedStarts: source.bookedRows.map((row) => new Date(row.startTime)),
      from,
      to,
      durationMin: source.duration,
    });
  }

  /**
   * Same grid as getAvailableSlots but ignores current bookings. Booking
   * validation uses this so a legit-but-taken slot reaches the INSERT guard
   * (which yields 409) instead of being rejected early with a 400.
   */
  async getSchedulableSlots(doctorId: number, from: string, to: string) {
    this.assertRange(from, to);
    const source = await this.loadSlotSource(doctorId, from, to);
    return generateSlots({
      schedule: source.schedule,
      blocks: source.blocks,
      bookedStarts: [],
      from,
      to,
      durationMin: source.duration,
    });
  }

  /**
   * Monthly analytics for a doctor, aggregated entirely in SQL (no rows are
   * pulled into JS). All values are derived in one query:
   *  - total_appointments: appointments whose slot falls in the month
   *  - cancellation_rate: cancelled / total
   *  - peak_booking_hours: mode() of the UTC booking hour (created_at)
   *  - avg_utilization: sum(booked minutes) / sum(scheduled minutes minus blocks)
   */
  async getAnalytics(doctorId: number, month: string) {
    const [doctor] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (!doctor) throw new NotFoundException('Doctor not found');

    const [year, mon] = month.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year!, mon! - 1, 1));
    const monthEnd = new Date(Date.UTC(year!, mon!, 1));

    const result = await this.db.execute<{
      total_appointments: number;
      cancellation_rate: number;
      peak_booking_hours: number | null;
      avg_utilization: number;
    }>(sql`
      WITH booked AS (
        SELECT
          count(*)::numeric AS total,
          count(*) FILTER (WHERE appointments.status = 'cancelled')::numeric AS cancelled,
          coalesce(sum(extract(epoch FROM (appointments.end_time - appointments.start_time)) / 60), 0) AS booked_minutes,
          mode() WITHIN GROUP (ORDER BY extract(hour FROM appointments.created_at AT TIME ZONE 'UTC')) AS peak_hour
        FROM appointments
        WHERE appointments.doctor_id = ${doctorId}
          AND appointments.start_time >= ${monthStart}
          AND appointments.start_time < ${monthEnd}
      ),
      scheduled AS (
        SELECT coalesce(sum(
            extract(epoch FROM (schedules.end_time - schedules.start_time)) / 60
            - (
              SELECT coalesce(sum(extract(epoch FROM
                  least(schedules.end_time, coalesce(blocks.end_time, schedules.end_time))
                  - greatest(schedules.start_time, coalesce(blocks.start_time, schedules.start_time))) / 60), 0)
              FROM blocked_slots blocks
              WHERE blocks.doctor_id = schedules.doctor_id
                AND blocks.block_date = days.day
                AND (blocks.start_time IS NULL
                     OR (blocks.start_time < schedules.end_time AND blocks.end_time > schedules.start_time))
            )
        ), 0) AS available_minutes
        FROM schedules
        CROSS JOIN LATERAL (
          SELECT (generate_series(${monthStart}::timestamptz,
                                  ${monthEnd}::timestamptz - interval '1 day',
                                  interval '1 day'))::date AS day
        ) days
        WHERE schedules.doctor_id = ${doctorId}
          AND extract(dow FROM days.day) = schedules.day_of_week
      )
      SELECT
        booked.total::int AS total_appointments,
        CASE WHEN booked.total > 0
             THEN round(booked.cancelled / booked.total, 4)::float8
             ELSE 0 END AS cancellation_rate,
        booked.peak_hour::int AS peak_booking_hours,
        CASE WHEN scheduled.available_minutes > 0
             THEN round(booked.booked_minutes / scheduled.available_minutes, 4)::float8
             ELSE 0 END AS avg_utilization
      FROM booked, scheduled
    `);

    return result.rows[0]!;
  }

  private assertRange(from: string, to: string) {
    if (to < from) {
      throw new BadRequestException('to must be on or after from');
    }
    const rangeDays =
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      (1000 * 60 * 60 * 24);
    if (rangeDays < 0 || rangeDays > MAX_SLOT_RANGE_DAYS) {
      throw new BadRequestException(`date range must be within ${MAX_SLOT_RANGE_DAYS} days`);
    }
  }

  private async loadSlotSource(doctorId: number, from: string, to: string) {
    const doctor = await this.db
      .select({ id: users.id, slotDurationMin: users.slotDurationMin })
      .from(users)
      .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (doctor.length === 0) {
      throw new NotFoundException('Doctor not found');
    }

    const [schedule, blocks, bookedRows] = await Promise.all([
      this.db.select().from(schedules).where(eq(schedules.doctorId, doctorId)),
      this.db
        .select()
        .from(blockedSlots)
        .where(
          and(
            eq(blockedSlots.doctorId, doctorId),
            gte(blockedSlots.blockDate, from),
            lte(blockedSlots.blockDate, to),
          ),
        ),
      this.db
        .select({ startTime: appointments.startTime })
        .from(appointments)
        .where(
          and(
            eq(appointments.doctorId, doctorId),
            eq(appointments.status, 'scheduled'),
            gte(appointments.startTime, new Date(`${from}T00:00:00Z`)),
            lte(appointments.startTime, new Date(`${to}T23:59:59.999Z`)),
          ),
        ),
    ]);

    return { duration: doctor[0]!.slotDurationMin, schedule, blocks, bookedRows };
  }
}