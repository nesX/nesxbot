/**
 * scripts/init-db.ts
 *
 * Aplica db/schema.sql contra la base configurada en .env.
 * Idempotente — crea las tablas propias de NesxTrader (backtest_runs,
 * backtest_trades) solo si no existen. No toca las tablas de market-tracker.
 *
 * Uso:  npm run init-db
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { loadEnv } from './lib/env.js';
import { createPool } from './lib/db.js';

async function main(): Promise<void> {
  loadEnv();
  const schemaPath = resolve(process.cwd(), 'db/schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');

  const pool = createPool();
  try {
    await pool.query(sql);
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'nesx'
        AND table_name IN ('backtest_runs', 'backtest_trades')
      ORDER BY table_name`);
    console.log('Esquema aplicado en nesx. Tablas presentes:', rows.map(r => r['table_name']).join(', '));
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error aplicando esquema:', (err as Error).message);
  process.exit(1);
});
