import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

async function run() {
  const migrationsFolder = resolve('drizzle');
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  if (!existsSync(journalPath)) {
    console.log('No migrations found yet — skipping.');
    return;
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  console.log('Running migrations ...');
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
