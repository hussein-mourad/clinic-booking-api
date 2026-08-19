import { index, integer, pgTable, serial, time, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { createdAt } from './timestamps';

export const schedules = pgTable(
  'schedules',
  {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dayOfWeek: integer('day_of_week').notNull(), // 0 = Sunday .. 6 = Saturday
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_schedules_doctor').on(t.doctorId),
    uniqueIndex('uq_schedules_doctor_day').on(t.doctorId, t.dayOfWeek),
  ],
);