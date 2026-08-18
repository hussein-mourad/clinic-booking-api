import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import type { Database } from '../database/database.module';
import { blockedSlots, schedules, users } from '../database/schema';
import { CreateBlockDto } from './dto/create-block.dto';
import { ScheduleEntryDto } from './dto/schedule-entry.dto';

export const SLOT_DURATION_OPTIONS = [15, 30, 60] as const;

const toHHMM = (t: string | null): string | null => (t ? t.slice(0, 5) : t);

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
    await this.db
      .update(users)
      .set({ slotDurationMin })
      .where(eq(users.id, doctorId));
  }
}