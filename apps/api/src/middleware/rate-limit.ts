import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../lib/errors.js';

interface RateLimitGuardOptions {
  bucket: string;
  limitPerMinute: number;
}

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

const WINDOW_MS = 60_000;

export function createIpRateLimitGuard(options: RateLimitGuardOptions) {
  const state = new Map<string, RateLimitBucket>();
  let lastCleanupAt = Date.now();

  function cleanup(now: number): void {
    if (now - lastCleanupAt < WINDOW_MS) {
      return;
    }

    for (const [key, bucket] of state.entries()) {
      if (bucket.resetAtMs <= now) {
        state.delete(key);
      }
    }
    lastCleanupAt = now;
  }

  function setHeaders(reply: FastifyReply, limit: number, remaining: number, resetAtMs: number): void {
    reply.header('x-ratelimit-limit', String(limit));
    reply.header('x-ratelimit-remaining', String(Math.max(0, remaining)));
    reply.header('x-ratelimit-reset', String(Math.ceil(resetAtMs / 1000)));
  }

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    cleanup(now);

    const ip = request.ip || 'unknown';
    const key = `${options.bucket}:${ip}`;

    const current = state.get(key);
    const active = current && current.resetAtMs > now ? current : { count: 0, resetAtMs: now + WINDOW_MS };
    active.count += 1;
    state.set(key, active);

    const remaining = options.limitPerMinute - active.count;
    setHeaders(reply, options.limitPerMinute, remaining, active.resetAtMs);

    if (active.count > options.limitPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((active.resetAtMs - now) / 1000));
      reply.header('retry-after', String(retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please retry later.', {
        retryAfterSeconds
      });
    }
  };
}
