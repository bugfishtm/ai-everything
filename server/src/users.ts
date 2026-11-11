import { z } from 'zod';
import { exec, q, q1 } from './db.js';
import { hashPassword } from './lib/crypto.js';
import { HttpError } from './lib/http.js';
import { ensureSysUser } from './lib/system.js';

export interface UserRow {
  id: number;
  email: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  created_at: Date;
  last_login_at: Date | null;
}

export type AuthUser = Omit<UserRow, 'password_hash'>;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, 'username: 2-32 chars, letters, digits, . _ -');
export const emailSchema = z.string().trim().toLowerCase().max(255).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'invalid email');
export const passwordSchema = z.string().min(8, 'password must have at least 8 characters').max(200);

export function publicUser(u: AuthUser | UserRow) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export async function countUsers(): Promise<number> {
  const r = await q1<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  return Number(r?.n ?? 0);
}

export async function getUser(id: number): Promise<AuthUser | null> {
  return q1<AuthUser>(
    'SELECT id, email, username, display_name, role, status, created_at, last_login_at FROM users WHERE id = ?',
    [id],
  );
}

export async function findUserForLogin(login: string): Promise<UserRow | null> {
  const l = login.trim().toLowerCase();
  return q1<UserRow>('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', [l, l]);
}

export async function createUser(input: {
  email: string;
  username: string;
  displayName?: string;
  password: string;
  role?: 'admin' | 'user';
}): Promise<AuthUser> {
  const email = emailSchema.parse(input.email);
  const username = usernameSchema.parse(input.username);
  const exists = await q1('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
  if (exists) throw new HttpError(409, 'email or username already taken');
  const hash = await hashPassword(input.password);
  const { insertId } = await exec(
    'INSERT INTO users (email, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [email, username, (input.displayName || username).trim().slice(0, 128), hash, input.role ?? 'user'],
  );
  await ensureSysUser(insertId);
  const u = await getUser(insertId);
  if (!u) throw new Error('user vanished');
  return u;
}

export async function listUsers(): Promise<AuthUser[]> {
  return q<AuthUser>(
    'SELECT id, email, username, display_name, role, status, created_at, last_login_at FROM users ORDER BY id',
  );
}
