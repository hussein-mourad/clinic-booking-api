import { integer, pgTable, serial, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums';
import { withTimestamps } from './timestamps';

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    role: userRoleEnum('role').notNull().default('patient'),
    slotDurationMin: integer('slot_duration_min').notNull().default(15),
    ...withTimestamps,
  },
  (t) => [uniqueIndex('uq_users_email').on(t.email)],
);