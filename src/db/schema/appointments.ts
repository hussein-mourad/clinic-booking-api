import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { appointmentStatusEnum } from './enums';
import { createdAt } from './timestamps';

export const appointments = pgTable(
  'appointments',
  {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id')
      .notNull()
      .references(() => users.id),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }).notNull(),
    status: appointmentStatusEnum('status').notNull().default('scheduled'),
    createdAt: createdAt(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_appointments_doctor_start').on(t.doctorId, t.startTime),
    index('idx_appointments_patient_start').on(t.patientId, t.startTime),
    uniqueIndex('uq_appt_active_slot')
      .on(t.doctorId, t.startTime)
      .where(sql`status = 'scheduled'`),
  ],
);
