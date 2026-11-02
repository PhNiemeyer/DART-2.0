import { Injectable, NestMiddleware } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { ZodType } from 'zod';
import { Db, Tx } from './db';
import { ApiError } from './errors';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

/** Request-ID, no-store für alle API-Antworten, CSRF-Schutz für Cookie-Sitzungen. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = randomUUID();
    (req as Request & { requestId: string }).requestId = id;
    res.setHeader('X-Request-Id', id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const bearer = req.header('authorization')?.startsWith('Bearer ');
    // Cookie-basierte Sitzungen: zusätzlicher Header, den fremde Seiten nicht setzen können
    if (unsafe && !bearer && req.header('x-dart-csrf') !== '1' && !req.path.startsWith('/api/v1/auth/oidc/')) {
      res.status(403).json({ code: 'KEINE_BERECHTIGUNG', message: 'CSRF-Schutz: Anfrage abgelehnt.', request_id: id });
      return;
    }
    next();
  }
}

/** Testumgebungen können Limits erhöhen (in Produktion verweigert, siehe config.ts). */
function multiplier(): number {
  return Math.max(1, Number(process.env.RATE_LIMIT_MULTIPLIER ?? 1));
}

/** Einfaches Rate Limit (Speicher, pro Prozess). IP-Adressen werden nicht persistiert. */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(req: Request, key: string, limit: number, windowMs: number): void {
  const k = `${key}:${req.ip}`;
  const now = Date.now();
  const b = buckets.get(k);
  if (!b || b.reset < now) {
    buckets.set(k, { n: 1, reset: now + windowMs });
    return;
  }
  b.n++;
  if (b.n > limit * multiplier()) throw new ApiError(429, 'ZU_VIELE_VERSUCHE');
}

export function resetRateLimits() {
  buckets.clear();
}

/**
 * Idempotenz für Create/Submit/Upload-Finalisierung: gleicher Key + gleiche Anfrage → gleiche Antwort;
 * gleicher Key + andere Anfrage → 422.
 */
@Injectable()
export class Idempotency {
  constructor(private readonly db: Db) {}

  async run<T extends object>(
    req: Request,
    actor: string,
    endpoint: string,
    body: unknown,
    exec: (c: Tx | null) => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T; replay: boolean }> {
    const key = req.header('idempotency-key');
    if (!key) {
      const r = await exec(null);
      return { ...r, replay: false };
    }
    if (key.length > 200) throw new ApiError(400, 'VALIDIERUNG', 'Idempotency-Key zu lang');
    const hash = createHash('sha256').update(`${endpoint}\n${JSON.stringify(body ?? null)}`).digest('hex');
    const existing = await this.db.app.query('SELECT request_hash, status_code, response, endpoint FROM idempotency_record WHERE actor = $1 AND key = $2', [actor, key]);
    if (existing.rows[0]) {
      const e = existing.rows[0];
      if (e.request_hash !== hash || e.endpoint !== endpoint) throw new ApiError(422, 'IDEMPOTENZ_KONFLIKT');
      return { status: e.status_code, body: e.response, replay: true };
    }
    const r = await exec(null);
    if (r.status < 300) {
      await this.db.app.query(
        'INSERT INTO idempotency_record (key, actor, endpoint, request_hash, status_code, response) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [key, actor, endpoint, hash, r.status, JSON.stringify(r.body)],
      );
    }
    return { ...r, replay: false };
  }
}
