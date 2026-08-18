import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import type { Database } from '../database/database.module';
import { appointments, blockedSlots, schedules, users } from '../database/schema';
import { generateSlots } from './slots.generator';
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