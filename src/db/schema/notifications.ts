import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { notificationTypeEnum } from './enums';

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
