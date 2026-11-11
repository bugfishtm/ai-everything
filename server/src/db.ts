import mysql from 'mysql2/promise';
import { config } from './config.js';
import { MIGRATIONS } from './migrations.js';

let pool: mysql.Pool;

export function getPool(): mysql.Pool {
  return pool;
}

/**
 * Columns declared as JSON. MySQL reports them as JSON (mysql2 parses them);
 * MariaDB stores JSON as LONGTEXT, so they arrive as strings — parse those here
 * so the rest of the code always sees objects.
 */
// (`settings` is also the JSON column of `services`)
const JSON_COLUMNS = new Set(['v', 'settings', 'last_status', 'rate_limit', 'payload', 'files', 'stats', 'artifacts', 'info']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function typeCast(field: any, next: () => unknown): unknown {
  const isJson =
    field.type === 'JSON' ||
    field.extendedFormat === 'json' || // MariaDB extended metadata
    (field.type === 'BLOB' && JSON_COLUMNS.has(String(field.name).toLowerCase()));
  if (!isJson) return next();
  const s: string | null = field.string('utf8');
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function dbTarget(): string {
  return config.db.host ? `${config.db.host}:${config.db.port}` : `the built-in database (${config.db.socket})`;
}

export async function connectDb(): Promise<void> {
  pool = mysql.createPool({
    ...(config.db.host ? { host: config.db.host, port: config.db.port } : { socketPath: config.db.socket }),
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 15,
    timezone: 'Z',
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    typeCast,
  });
  const deadline = Date.now() + 120_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      console.log(`[db] waiting for ${dbTarget()} … (${(err as Error).message})`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw new Error(`Could not connect to ${dbTarget()}: ${(lastErr as Error)?.message}`);
}

/** Cheap liveness check for /api/health. */
export async function dbAlive(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = any[];

export async function q<T = Record<string, unknown>>(sql: string, params: Params = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function q1<T = Record<string, unknown>>(sql: string, params: Params = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: Params = []): Promise<{ insertId: number; affectedRows: number }> {
  const [res] = await pool.query(sql, params);
  const r = res as mysql.ResultSetHeader;
  return { insertId: r.insertId, affectedRows: r.affectedRows };
}

export async function migrate(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INT UNSIGNED PRIMARY KEY,
       name VARCHAR(128) NOT NULL,
       applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  const done = new Set((await q<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    console.log(`[db] applying migration ${m.version} ${m.name}`);
    for (const stmt of m.statements) await pool.query(stmt);
    await pool.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
  }
}
