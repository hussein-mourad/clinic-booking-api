import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import type { Database } from '../database/database.module';
import { appointments, blockedSlots, schedules, users } from '../database/schema';
import { CreateBlockDto } from './dto/create-block.dto';
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
    if (to < from) {
      throw new BadRequestException('to must be on or after from');
    }
    const rangeDays =
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      (1000 * 60 * 60 * 24);
    if (rangeDays < 0 || rangeDays > MAX_SLOT_RANGE_DAYS) {
      throw new BadRequestException(`date range must be within ${MAX_SLOT_RANGE_DAYS} days`);
    }

    const doctor = await this.db
      .select({ id: users.id, slotDurationMin: users.slotDurationMin })
      .from(users)
      .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (doctor.length === 0) {
      throw new NotFoundException('Doctor not found');
    }
    const duration = doctor[0]!.slotDurationMin;

    const rows = await this.db.execute(sql`
      WITH candidate AS (
        SELECT
          d::date AS slot_date,
          (d::date + s.start_time AT TIME ZONE 'UTC') AS slot_start,
          (d::date + s.end_time AT TIME ZONE 'UTC') AS day_end
        FROM generate_series(${from}::date, ${to}::date, '1 day'::interval) d
        JOIN schedules s
          ON s.doctor_id = ${doctorId}
         AND EXTRACT(DOW FROM d::date)::int = s.day_of_week
      ),
      slot_series AS (
        SELECT
          slot_date,
          generate_series(
            slot_start,
            day_end - make_interval(mins => ${duration}),
            make_interval(mins => ${duration})
          ) AS start_ts
        FROM candidate
      )
      SELECT
        start_ts AS start,
        start_ts + make_interval(mins => ${duration}) AS "end"
      FROM slot_series ss
      WHERE NOT EXISTS (
        SELECT 1 FROM blocked_slots b
        WHERE b.doctor_id = ${doctorId}
          AND b.block_date = ss.slot_date
          AND (
            b.start_time IS NULL
            OR (
              ss.start_ts < (ss.slot_date + b.end_time AT TIME ZONE 'UTC')
              AND ss.start_ts + make_interval(mins => ${duration})
                    > (ss.slot_date + b.start_time AT TIME ZONE 'UTC')
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.doctor_id = ${doctorId}
          AND a.status = 'scheduled'
          AND a.start_time = ss.start_ts
      )
      ORDER BY start_ts;
    `);

    return rows.rows.map((row) => ({
      start: new Date(row.start as string).toISOString(),
      end: new Date(row.end as string).toISOString(),
    }));
  }
}