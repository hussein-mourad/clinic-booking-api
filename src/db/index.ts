import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema';

export * from './schema';
export * from './types';

export type Database = NodePgDatabase<typeof schema>;

/** Build a tagged Drizzle client bound to the given pg Pool. */
export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}
