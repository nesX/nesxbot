import pg from 'pg';
import type { PoolConfig } from 'pg';

const { Pool } = pg;
/** Tipo de instancia del Pool de pg (no el constructor). */
export type Pool = InstanceType<typeof Pool>;

/**
 * Crea un Pool de conexiones PostgreSQL a partir de las variables de entorno.
 * Requiere que loadEnv() haya sido llamado antes.
 *
 * @param options - Opciones adicionales que sobreescriben los valores por defecto
 *                  (e.g. `{ max: 2 }` para workers con cache activo).
 */
export function createPool(options?: PoolConfig): InstanceType<typeof Pool> {
  return new Pool({
    host:     process.env['DB_HOST']     ?? 'localhost',
    port:     Number(process.env['DB_PORT'] ?? 5432),
    user:     process.env['DB_USER']     ?? 'postgres',
    password: process.env['DB_PASSWORD'] ?? '',
    database: process.env['DB_NAME']     ?? 'market_tracker',
    ...options,
  });
}
