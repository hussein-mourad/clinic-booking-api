import { index, integer, pgTable, serial, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';
import { waitlistStatusEnum } from './enums';
import { createdAt } from './timestamps';

export const waitingList = pgTable(
  'waiting_list',
  {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id')
      .notNull()
      .references(() => users.id),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    position: integer('position').notNull(),
    status: waitlistStatusEnum('status').notNull().default('waiting'),
    offeredAt: timestamp('offered_at', { withTimezone: true }),
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('idx_waiting_list_slot').on(t.doctorId, t.slotStart)],
);