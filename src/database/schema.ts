import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['patient', 'doctor']);
export const appointmentStatusEnum = pgEnum('appointment_status', [
  'scheduled',
  'cancelled',
  'completed',
]);
export const waitlistStatusEnum = pgEnum('waitlist_status', [
  'waiting',
  'offered',
  'accepted',
  'expired',
  'declined',
]);
export const notificationTypeEnum = pgEnum('notification_type', [
  'reminder',
  'waitlist_offer',
  'waitlist_confirmation',
]);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    role: userRoleEnum('role').notNull().default('patient'),
    slotDurationMin: integer('slot_duration_min').notNull().default(15),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_users_email').on(t.email)],
);

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_schedules_doctor').on(t.doctorId),
    uniqueIndex('uq_schedules_doctor_day').on(t.doctorId, t.dayOfWeek),
  ],
);

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_blocked_slots_doctor_date').on(t.doctorId, t.blockDate)],
);

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_waiting_list_slot').on(t.doctorId, t.slotStart)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    type: notificationTypeEnum('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_notifications_user').on(t.userId)],
);
