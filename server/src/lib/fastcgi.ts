/**
 * A small FastCGI client (responder role) — how the Studio hands a request to PHP-FPM.
 * One connection per request over a Unix socket; the response is streamed.
 */
import net from 'node:net';
import { PassThrough, type Readable } from 'node:stream';

const VERSION = 1;
const BEGIN_REQUEST = 1;
const END_REQUEST = 3;
const PARAMS = 4;
const STDIN = 5;
const STDOUT = 6;
const STDERR = 7;
const MAX_RECORD = 65535;
const MAX_HEADER_BYTES = 256 * 1024;

function record(type: number, content: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head[0] = VERSION;
  head[1] = type;
  head.writeUInt16BE(1, 2); // request id
  head.writeUInt16BE(content.length, 4);
  // padding 0, reserved 0
  return content.length ? Buffer.concat([head, content]) : head;
}

function lengthBytes(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  const b = Buffer.alloc(4);
  // (>>> 0: the bit operation gives a signed number)
  b.writeUInt32BE((n | 0x80000000) >>> 0, 0);
  return b;
}

function encodeParams(params: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(params)) {
    const name = Buffer.from(k, 'latin1');
    const value = Buffer.from(v ?? '', 'utf8');
    parts.push(lengthBytes(name.length), lengthBytes(value.length), name, value);
  }
  return Buffer.concat(parts);
}

function chunked(type: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += MAX_RECORD) out.push(record(type, data.subarray(i, i + MAX_RECORD)));
  return out;
}

export interface FcgiResponse {
  status: number;
  /** response headers in the order PHP sent them (names as sent; Set-Cookie may repeat) */
  headers: [string, string][];
  body: Readable;
  /** what PHP wrote to stderr so far (errors, notices) */
  stderr: () => string;
}

export interface FcgiOptions {
  /** no first byte of an answer within this time → error */
  timeoutMs?: number;
  /** the request body is cut off (and the request fails) beyond this many bytes */
  maxBodyBytes?: number;
}

export class FcgiError extends Error {
  constructor(
    message: string,
    public code: 'connect' | 'timeout' | 'protocol' | 'body-too-large' | 'aborted',
  ) {
    super(message);
  }
}

/**
 * Sends one request. Resolves when the response headers are complete; the body follows as a stream.
 */
export function fcgiRequest(socketPath: string, params: Record<string, string>, body: Readable | null, opts: FcgiOptions = {}): Promise<FcgiResponse> {
  return new Promise<FcgiResponse>((resolve, reject) => {
    const socket = net.connect(socketPath);
    const out = new PassThrough();
    let settled = false;
    let ended = false;
    let buf: Buffer = Buffer.alloc(0);
    let headBuf: Buffer | null = Buffer.alloc(0);
    let stderr = '';
    let sent = 0;

    const fail = (err: FcgiError) => {
      if (!settled) {
        settled = true;
        reject(err);
      } else if (!ended) {
        out.destroy(err);
      }
      socket.destroy();
      if (body) body.unpipe?.();
    };
    const timer = setTimeout(() => fail(new FcgiError('PHP did not answer in time', 'timeout')), opts.timeoutMs ?? 300_000);

    const finishHeaders = (raw: string, rest: Buffer) => {
      headBuf = null;
      let status = 200;
      const headers: [string, string][] = [];
      let location = false;
      for (const line of raw.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        const lower = name.toLowerCase();
        if (lower === 'status') {
          const n = Number.parseInt(value, 10);
          if (n >= 100 && n <= 599) status = n;
          continue;
        }
        if (lower === 'location') location = true;
        headers.push([name, value]);
      }
      if (location && status === 200) status = 302;
      clearTimeout(timer);
      settled = true;
      resolve({ status, headers, body: out, stderr: () => stderr });
      if (rest.length) out.write(rest);
    };

    const onStdout = (chunk: Buffer) => {
      if (headBuf === null) {
        if (!out.write(chunk)) {
          socket.pause();
          out.once('drain', () => socket.resume());
        }
        return;
      }
      headBuf = Buffer.concat([headBuf, chunk]);
      let end = headBuf.indexOf('\r\n\r\n');
      let sep = 4;
      const alt = headBuf.indexOf('\n\n');
      if (alt >= 0 && (end < 0 || alt < end)) {
        end = alt;
        sep = 2;
      }
      if (end >= 0) finishHeaders(headBuf.subarray(0, end).toString('latin1'), headBuf.subarray(end + sep));
      else if (headBuf.length > MAX_HEADER_BYTES) fail(new FcgiError('PHP sent no valid response headers', 'protocol'));
    };

    const onEnd = () => {
      ended = true;
      clearTimeout(timer);
      if (headBuf !== null) {
        // output without a header block (or nothing at all)
        if (headBuf.length || !stderr) finishHeaders('', headBuf);
        else {
          settled = true;
          reject(new FcgiError(`PHP ended without an answer: ${stderr.trim().slice(0, 400)}`, 'protocol'));
        }
      }
      out.end();
      socket.end();
    };

    socket.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 8) {
        const type = buf[1];
        const len = buf.readUInt16BE(4);
        const pad = buf[6];
        if (buf.length < 8 + len + pad) break;
        const content = buf.subarray(8, 8 + len);
        buf = buf.subarray(8 + len + pad);
        if (type === STDOUT) {
          if (len) onStdout(content);
        } else if (type === STDERR) {
          if (stderr.length < 64 * 1024) stderr += content.toString('utf8');
        } else if (type === END_REQUEST) {
          onEnd();
          return;
        }
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      if (ended) return;
      fail(new FcgiError(settled ? err.message : `PHP is not reachable (${err.message})`, settled ? 'protocol' : 'connect'));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (ended) return;
      if (!settled) fail(new FcgiError('PHP closed the connection without an answer', 'protocol'));
      else if (!out.writableEnded) out.destroy(new FcgiError('PHP closed the connection early', 'protocol'));
    });
    // the browser went away: stop PHP's output from piling up
    out.on('close', () => {
      if (!ended) socket.destroy();
    });

    socket.on('connect', () => {
      try {
        const begin = Buffer.alloc(8);
        begin.writeUInt16BE(1, 0); // role: responder
        begin[2] = 0; // flags: close the connection when done
        const encoded = encodeParams(params);
        socket.write(Buffer.concat([record(BEGIN_REQUEST, begin), ...chunked(PARAMS, encoded), record(PARAMS, Buffer.alloc(0))]));
      } catch (err) {
        // never an exception outside the request: it would be an uncaught one
        fail(new FcgiError(`The request could not be handed to PHP: ${(err as Error).message}`, 'protocol'));
        return;
      }
      if (!body) {
        socket.write(record(STDIN, Buffer.alloc(0)));
        return;
      }
      body.on('data', (d: Buffer) => {
        sent += d.length;
        if (opts.maxBodyBytes && sent > opts.maxBodyBytes) {
          body.pause();
          fail(new FcgiError('The request body is too large', 'body-too-large'));
          return;
        }
        let ok = true;
        for (const rec of chunked(STDIN, d)) ok = socket.write(rec);
        if (!ok) {
          body.pause();
          socket.once('drain', () => body.resume());
        }
      });
      body.on('end', () => {
        if (!socket.destroyed) socket.write(record(STDIN, Buffer.alloc(0)));
      });
      body.on('error', () => fail(new FcgiError('The request was aborted', 'aborted')));
      body.on('aborted', () => fail(new FcgiError('The request was aborted', 'aborted')));
    });
  });
}
