/**
 * lib/http.js
 * ---------------------------------------------------------------------------
 * Small helpers shared by the API routes: consistent JSON envelopes, body
 * parsing with a size guard, and a best-effort in-memory rate limiter.
 */

import { NextResponse } from 'next/server';

export function jsonOk(data, init = {}) {
  return NextResponse.json({ ok: true, ...data }, { status: 200, ...init });
}

export function jsonError(message, status = 400, extra = {}) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

/** Parses a JSON body, returning a descriptive error rather than throwing. */
export async function readJsonBody(request, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const contentLength = Number(request.headers.get('content-length') || 0);

  if (contentLength > maxBytes) {
    throw Object.assign(
      new Error(`Request body is too large (${Math.round(contentLength / 1024 / 1024)} MB). Vercel caps bodies at ~4.5 MB.`),
      { status: 413 },
    );
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') {
      throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
    }
    return body;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('Request body is not valid JSON.'), { status: 400 });
  }
}

/**
 * In-memory sliding-window rate limiter.
 *
 * Honest about its limits: serverless instances do not share memory, so this
 * throttles a single warm instance rather than the deployment as a whole. It
 * is enough to stop an accidental loop from hammering third-party sites. For
 * a hard global limit, put Upstash Redis (also free-tier) in front of it.
 */
const buckets = new Map();

export function rateLimit(key, { limit = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const timestamps = (buckets.get(key) || []).filter((ts) => now - ts < windowMs);

  if (timestamps.length >= limit) {
    const retryAfter = Math.ceil((windowMs - (now - timestamps[0])) / 1000);
    return { allowed: false, retryAfter };
  }

  timestamps.push(now);
  buckets.set(key, timestamps);

  // Opportunistic cleanup so the map does not grow without bound on a
  // long-lived instance.
  if (buckets.size > 500) {
    for (const [bucketKey, values] of buckets) {
      if (!values.some((ts) => now - ts < windowMs)) buckets.delete(bucketKey);
    }
  }

  return { allowed: true, remaining: limit - timestamps.length };
}

/** Best-effort client identifier for rate-limit bucketing. */
export function clientKey(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}
