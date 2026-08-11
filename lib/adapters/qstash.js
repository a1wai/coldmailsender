/**
 * lib/adapters/qstash.js
 * ---------------------------------------------------------------------------
 * Optional adapter for Upstash QStash — free tier, 500 messages/day.
 *
 * The default campaign runner lives in the browser (`lib/queue.js`), which
 * means the tab has to stay open. QStash removes that constraint: each e-mail
 * is scheduled as a delayed HTTP callback to `/api/send-email`, so the campaign
 * continues even after the browser closes.
 *
 * Called over plain REST so the project needs no extra dependency. Signature
 * verification is implemented against the documented JWT scheme using Node's
 * built-in `crypto`.
 */

import crypto from 'node:crypto';
import axios from 'axios';

const QSTASH_API = 'https://qstash.upstash.io/v2';

export function isQStashEnabled() {
  return Boolean(process.env.QSTASH_TOKEN && process.env.QSTASH_CALLBACK_BASE_URL);
}

/**
 * Schedules one message for delayed delivery.
 *
 * @param {object} params
 * @param {object} params.payload      JSON body forwarded to the callback.
 * @param {number} params.delaySeconds Delay before QStash calls back.
 * @param {string} [params.path='/api/send-email']
 * @returns {Promise<{ messageId: string, scheduledFor: string }>}
 */
export async function enqueueSend({ payload, delaySeconds = 0, path = '/api/send-email' }) {
  const token = process.env.QSTASH_TOKEN;
  const baseUrl = process.env.QSTASH_CALLBACK_BASE_URL;

  if (!token) throw new Error('QSTASH_TOKEN is not set.');
  if (!baseUrl) throw new Error('QSTASH_CALLBACK_BASE_URL is not set.');

  const callbackUrl = `${baseUrl.replace(/\/$/, '')}${path}`;

  if (!callbackUrl.startsWith('https://')) {
    throw new Error('QStash can only call back to a public HTTPS URL — localhost will not work.');
  }

  try {
    const { data } = await axios.post(`${QSTASH_API}/publish/${callbackUrl}`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Upstash-Delay': `${Math.max(0, Math.round(delaySeconds))}s`,
        // QStash retries on non-2xx. Two extra attempts is a sane ceiling for
        // e-mail: more risks duplicate sends if the SMTP call half-succeeds.
        'Upstash-Retries': '2',
      },
      timeout: 15_000,
    });

    return {
      messageId: data?.messageId || '',
      scheduledFor: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    };
  } catch (error) {
    const status = error?.response?.status;
    if (status === 401) throw new Error('QStash rejected the token. Check QSTASH_TOKEN.');
    if (status === 429) throw new Error('QStash daily message quota reached (500/day on the free tier).');
    throw new Error(`QStash publish failed: ${error?.message || 'unknown error'}`);
  }
}

/**
 * Schedules a whole campaign, spacing messages by the configured delay.
 * Returns one entry per lead so the UI can show what was scheduled.
 */
export async function enqueueCampaign(messages, { minDelaySeconds = 5, maxDelaySeconds = 15 } = {}) {
  const results = [];
  let cumulativeDelay = 0;

  for (const [index, payload] of messages.entries()) {
    if (index > 0) {
      const gap = Math.floor(Math.random() * (maxDelaySeconds - minDelaySeconds + 1)) + minDelaySeconds;
      cumulativeDelay += gap;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await enqueueSend({ payload, delaySeconds: cumulativeDelay });
      results.push({ ok: true, email: payload.to, ...result });
    } catch (error) {
      results.push({ ok: false, email: payload.to, error: error.message });
    }
  }

  return results;
}

/**
 * Verifies the `Upstash-Signature` header on an incoming callback.
 *
 * Without this, anyone who discovers the endpoint URL can POST to it and make
 * the deployment send mail. Any route that accepts QStash callbacks must call
 * this before acting on the body.
 *
 * @param {string} signature  Raw `Upstash-Signature` header.
 * @param {string} body       Exact raw request body.
 * @param {string} url        Full URL the request was delivered to.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyQStashSignature(signature, body, url) {
  const keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].filter(Boolean);

  if (!keys.length) return { valid: false, reason: 'No QStash signing keys configured.' };
  if (!signature) return { valid: false, reason: 'Missing Upstash-Signature header.' };

  const parts = signature.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'Malformed signature.' };

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  // QStash signs with HS256 over "<header>.<payload>", rotating between a
  // current and next key — accept either.
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const matchesAnyKey = keys.some((key) => {
    const expected = crypto.createHmac('sha256', key).update(signingInput).digest('base64url');
    const provided = Buffer.from(encodedSignature);
    const computed = Buffer.from(expected);
    // Length check first: timingSafeEqual throws on a length mismatch.
    return provided.length === computed.length && crypto.timingSafeEqual(provided, computed);
  });

  if (!matchesAnyKey) return { valid: false, reason: 'Signature does not match any signing key.' };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'Signature payload is not valid JSON.' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > claims.exp) return { valid: false, reason: 'Signature has expired.' };
  if (claims.nbf && now < claims.nbf) return { valid: false, reason: 'Signature is not yet valid.' };

  // `sub` is the destination URL — confirms the signature was minted for this
  // endpoint and is not replayed from another route.
  if (claims.sub && url && !urlsMatch(claims.sub, url)) {
    return { valid: false, reason: 'Signature was issued for a different URL.' };
  }

  // `body` claim is the base64url-encoded SHA-256 of the raw body.
  if (claims.body) {
    const bodyHash = crypto.createHash('sha256').update(body).digest('base64url');
    // Strip any base64 padding before comparing.
    if (bodyHash !== String(claims.body).replace(/=+$/, '')) {
      return { valid: false, reason: 'Body hash does not match the signature.' };
    }
  }

  return { valid: true };
}

function urlsMatch(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.host === right.host && left.pathname === right.pathname;
  } catch {
    return a === b;
  }
}
