import { date, index, integer, pgTable, serial, time } from 'drizzle-orm/pg-core';
import { users } from './users';
import { createdAt } from './timestamps';

export const blockedSlots = pgTable(
  'blocked_slots',
  {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockDate: date('block_date').notNull(),
    startTime: time('start_time'), // null times => full-day block
    endTime: time('end_time'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_blocked_slots_doctor_date').on(t.doctorId, t.blockDate)],
);