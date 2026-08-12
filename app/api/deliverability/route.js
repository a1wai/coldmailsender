/**
 * POST /api/deliverability
 * ---------------------------------------------------------------------------
 * Answers "why does my mail go to spam?" with evidence rather than advice.
 *
 * Two halves:
 *   - DNS: is the sending domain authenticated (SPF / DKIM / DMARC / MX)?
 *     This is usually the real answer.
 *   - Content: does the message itself trip well-known filters?
 *
 * Request:  { email?: string, subject?: string, body?: string,
 *             attachmentCount?: number, hasUnsubscribe?: bool,
 *             hasPostalAddress?: bool }
 * Response: { ok: true, dns: {...}|null, content: {...}|null, playbook: [...] }
 *
 * Both halves are optional — pass just an address for a DNS audit, or just a
 * message for a content check.
 */

import { auditSendingDomain } from '@/lib/dns-auth';
import { analyseMessage, DELIVERABILITY_PLAYBOOK } from '@/lib/spam-check';
import { jsonOk, jsonError, readJsonBody, rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  const limit = rateLimit(`deliverability:${clientKey(request)}`, { limit: 20, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonError(`Too many checks. Wait ${limit.retryAfter}s.`, 429, { retryAfter: limit.retryAfter });
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 128 * 1024 });
  } catch (error) {
    return jsonError(error.message, error.status || 400);
  }

  const { email, subject, body: messageBody, attachmentCount, hasUnsubscribe, hasPostalAddress } = body;

  let dns = null;
  let dnsError = null;

  if (email) {
    try {
      dns = await auditSendingDomain(email);
    } catch (error) {
      // A DNS failure must not sink the content half of the report.
      dnsError = error.message;
    }
  }

  const content =
    subject || messageBody
      ? analyseMessage({
          subject: subject || '',
          body: messageBody || '',
          fromEmail: email || '',
          attachmentCount: Number(attachmentCount) || 0,
          hasUnsubscribe: hasUnsubscribe !== false,
          hasPostalAddress: hasPostalAddress !== false,
        })
      : null;

  return jsonOk({ dns, dnsError, content, playbook: DELIVERABILITY_PLAYBOOK });
}
