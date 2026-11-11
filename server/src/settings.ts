import { config } from './config.js';
import { exec, q1 } from './db.js';

const cache = new Map<string, unknown>();

export async function getSetting<T>(k: string, def: T): Promise<T> {
  if (cache.has(k)) return cache.get(k) as T;
  const row = await q1<{ v: unknown }>('SELECT v FROM settings WHERE k = ?', [k]);
  // JSON columns arrive parsed (db.ts typeCast) — on MySQL and MariaDB alike
  const v = row ? row.v : def;
  cache.set(k, v);
  return v as T;
}

export async function setSetting(k: string, v: unknown): Promise<void> {
  await exec('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
  cache.set(k, v);
}

export async function registrationOpen(): Promise<boolean> {
  return (await getSetting<string>('registration', config.registrationDefault)) === 'open';
}
