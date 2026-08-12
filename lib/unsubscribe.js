/**
 * lib/unsubscribe.js
 * ---------------------------------------------------------------------------
 * Self-hosted one-click opt-out (RFC 8058).
 *
 * ## Why this matters more than it looks
 *
 * Since February 2024 Google and Yahoo have required bulk senders to offer
 * one-click unsubscribe, and both weigh the headers when deciding inbox versus
 * spam. The requirement is written for 5,000+/day senders, but the *scoring*
 * is not gated on volume: a message carrying a working `List-Unsubscribe` and
 * `List-Unsubscribe-Post` is treated as better-behaved than one without, at
 * any volume.
 *
 * A `mailto:` opt-out alone does not satisfy one-click — RFC 8058 is defined
 * over HTTPS only. Before this module the app emitted `List-Unsubscribe-Post`
 * only when the user had gone and hosted an unsubscribe page somewhere, which
 * essentially nobody does. Now the app hosts one itself.
 *
 * ## Tokens
 *
 * The link carries an encoded token rather than a bare `?email=` parameter.
 * Note what that is and is not: the payload is base64url, which is encoding
 * and not encryption — anyone who decodes it reads the address. It keeps the
 * address out of casual log greps and out of a copy-pasted URL, nothing more.
 * The security property comes from the signature, not the encoding.
 *
 * When `UNSUBSCRIBE_SECRET` is set the token is HMAC-signed and forged ones are
 * rejected. Without it the token is unauthenticated and the route falls back to
 * rate limiting alone. That degradation is deliberate: the worst
 * a forged token achieves is adding an address to *your own* suppression list,
 * which is a nuisance rather than a breach, and requiring configuration would
 * mean most installs ship with no one-click header at all — a strictly worse
 * outcome for deliverability.
 *
 * Server-only.
 */

import crypto from 'node:crypto';

const TOKEN_VERSION = 'u1';

/** Opt-out links must keep working long after a campaign ends. */
const MAX_TOKEN_AGE_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months

export function isUnsubscribeSigningConfigured() {
  return Boolean(process.env.UNSUBSCRIBE_SECRET);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload) {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) return '';
  return base64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

/**
 * Builds the opaque token for one recipient.
 *
 * @param {string} email     The recipient opting out.
 * @param {string} [sender]  Who sent to them, so a shared deployment can tell
 *                           whose list the address should leave.
 */
export function encodeOptOutToken(email, sender = '') {
  const payload = base64url(
    JSON.stringify({
      v: TOKEN_VERSION,
      e: String(email || '').trim().toLowerCase(),
      s: String(sender || '').trim().toLowerCase(),
      t: Date.now(),
    }),
  );

  const signature = sign(payload);
  return signature ? `${payload}.${signature}` : payload;
}

/**
 * Reverses `encodeOptOutToken`.
 *
 * @returns {{ ok: boolean, email?: string, sender?: string, verified: boolean, reason?: string }}
 */
export function decodeOptOutToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, verified: false, reason: 'Missing token.' };

  const [payload, signature] = raw.split('.');
  const secret = process.env.UNSUBSCRIBE_SECRET;
  let verified = false;

  if (secret) {
    if (!signature) return { ok: false, verified: false, reason: 'Token is not signed.' };

    const expected = sign(payload);
    const provided = Buffer.from(signature);
    const wanted = Buffer.from(expected);

    // Length check first: timingSafeEqual throws on a length mismatch, and
    // the length is not a secret.
    if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
      return { ok: false, verified: false, reason: 'Token signature does not match.' };
    }
    verified = true;
  }

  let data;
  try {
    data = JSON.parse(fromBase64url(payload).toString('utf8'));
  } catch {
    return { ok: false, verified, reason: 'Token is malformed.' };
  }

  if (data?.v !== TOKEN_VERSION) return { ok: false, verified, reason: 'Unrecognised token version.' };
  if (!data.e || !data.e.includes('@')) return { ok: false, verified, reason: 'Token carries no address.' };

  if (Number.isFinite(data.t) && Date.now() - data.t > MAX_TOKEN_AGE_MS) {
    return { ok: false, verified, reason: 'This opt-out link has expired.' };
  }

  return { ok: true, email: data.e, sender: data.s || '', verified };
}

/**
 * Works out the public origin this deployment answers on.
 *
 * Preference order matters. An explicit value wins because a custom domain is
 * what recipients should see; Vercel's production URL beats `VERCEL_URL`,
 * which points at the immutable per-deployment hostname and would leave old
 * campaigns pointing at a deployment that has since been superseded.
 *
 * @param {Request} [request] Falls back to the incoming request's own origin.
 */
export function resolveAppOrigin(request) {
  const explicit =
    process.env.UNSUBSCRIBE_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    '';

  if (explicit) {
    const withProtocol = /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;
    try {
      return new URL(withProtocol).origin;
    } catch {
      /* fall through to the request */
    }
  }

  if (request?.url) {
    try {
      const url = new URL(request.url);
      // Behind Vercel's proxy the internal request is http; the public one is not.
      const proto = request.headers?.get?.('x-forwarded-proto') || url.protocol.replace(':', '');
      const host = request.headers?.get?.('x-forwarded-host') || url.host;
      return `${proto}://${host}`;
    } catch {
      /* nothing else to try */
    }
  }

  return '';
}

/**
 * The full one-click URL for a recipient, or `''` when there is no origin to
 * build it from (local `next dev` without a configured base URL).
 */
export function buildUnsubscribeUrl({ origin, email, sender }) {
  if (!origin || !email) return '';
  return `${origin.replace(/\/$/, '')}/api/unsubscribe?t=${encodeURIComponent(encodeOptOutToken(email, sender))}`;
}
