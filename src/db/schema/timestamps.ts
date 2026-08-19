import { timestamp } from 'drizzle-orm/pg-core';

/** Fresh `created_at` column (UTC). */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Fresh `updated_at` column (UTC). */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Standard `created_at` + `updated_at` pair to spread into a table definition:
 *   ...withTimestamps
 * Only usable once (a table gets each column instance once); for a single
 * created-at column use `createdAt: createdAt()` instead.
 */
export const withTimestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};