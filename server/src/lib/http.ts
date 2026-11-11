import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${issue?.message ?? 'invalid input'}`);
  }
  return r.data;
}

export function intParam(v: unknown, name = 'id'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `invalid ${name}`);
  return n;
}

/** Express 5 wildcard params arrive as string[] */
export function wildcard(v: unknown): string {
  if (Array.isArray(v)) return v.join('/');
  if (typeof v === 'string') return v;
  return '';
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request too large' });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  console.error('[http] unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * An address of this machine or a private network (loopback, RFC 1918, link-local, carrier NAT /
 * VPN ranges, IPv6 unique-local) — not someone from the open internet.
 */
export function isPrivateAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  let a = ip.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1') return true;
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (net.isIPv6(a)) return /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}
