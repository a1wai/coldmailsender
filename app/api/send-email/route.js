/**
 * POST /api/send-email
 * ---------------------------------------------------------------------------
 * Sends exactly ONE e-mail per invocation.
 *
 * One-per-request is the whole architecture: a campaign that waits 5–15s
 * between messages runs for many minutes, far past any serverless timeout.
 * The browser (`lib/queue.js`) owns the schedule and calls this route once per
 * recipient, so every invocation finishes in about a second.
 *
 * Request:
 *   {
 *     to: string,                       // required
 *     subject: string,                  // required (already rendered)
 *     html: string,                     // required (already rendered)
 *     text?: string,
 *     attachments?: [{ filename, content /* base64 *\/, contentType }],
 *     credentials?: { user, pass, fromName, host, port, secure, replyTo },
 *     compliance?: { postalAddress, unsubscribeEmail, unsubscribeUrl, appendFooter },
 *     meta?: { templateId, templateName }   // for optional Supabase logging
 *   }
 *
 * Response:
 *   { ok: true, messageId, accepted, rejected }
 *   { ok: false, error, retryable }
 *
 * Also accepts QStash callbacks — when an `Upstash-Signature` header is
 * present the signature is verified before anything is sent, so the endpoint
 * cannot be driven by a stranger who guesses the URL.
 */

import { sendMail } from '@/lib/mailer';
import { verifyQStashSignature } from '@/lib/adapters/qstash';
import { logCampaignEvent, updateLeadStatus, isSupabaseEnabled } from '@/lib/adapters/supabase';
import { jsonOk, jsonError, rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  // Read the body as raw text first: QStash signature verification hashes the
  // exact bytes, and a re-serialised object would not match.
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError('Could not read the request body.', 400);
  }

  if (rawBody.length > 4 * 1024 * 1024) {
    return jsonError('Request body exceeds the ~4.5 MB serverless limit. Reduce attachment size.', 413);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError('Request body is not valid JSON.', 400);
  }

  // --- QStash callback authentication -------------------------------------
  const signature = request.headers.get('upstash-signature');
  const isQStashCallback = Boolean(signature);

  if (isQStashCallback) {
    const verification = verifyQStashSignature(signature, rawBody, request.url);
    if (!verification.valid) {
      console.warn('[api/send-email] Rejected QStash callback:', verification.reason);
      return jsonError(`Invalid QStash signature: ${verification.reason}`, 401);
    }
  } else {
    // Browser-driven sends get rate limited. The ceiling is generous enough
    // for a fast campaign but stops a runaway loop from burning the daily quota.
    const limit = rateLimit(`send:${clientKey(request)}`, { limit: 60, windowMs: 60_000 });
    if (!limit.allowed) {
      return jsonError(
        `Sending too fast. Wait ${limit.retryAfter}s. Increase the delay between sends in the campaign settings.`,
        429,
        { retryAfter: limit.retryAfter, retryable: true },
      );
    }
  }

  const { to, subject, html, text, attachments = [], credentials = {}, compliance = {}, meta = {} } = body;

  try {
    const result = await sendMail({ credentials, to, subject, html, text, attachments, compliance });

    // Optional persistence — never allowed to fail the send.
    if (isSupabaseEnabled()) {
      await Promise.allSettled([
        logCampaignEvent({
          email: to,
          templateId: meta.templateId,
          templateName: meta.templateName,
          subject,
          status: 'sent',
          messageId: result.messageId,
        }),
        updateLeadStatus(to, 'sent'),
      ]);
    }

    return jsonOk({
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      to,
    });
  } catch (error) {
    console.error('[api/send-email] Send failed:', error.message);

    if (isSupabaseEnabled()) {
      await Promise.allSettled([
        logCampaignEvent({
          email: to,
          templateId: meta.templateId,
          templateName: meta.templateName,
          subject,
          status: 'failed',
          error: error.message,
        }),
        updateLeadStatus(to, 'failed'),
      ]);
    }

    // Credential and content problems are the caller's fault (4xx); SMTP
    // transport failures are a server-side condition (5xx) and may be retried.
    const status = ['credentials', 'recipient', 'content', 'attachment'].includes(error.kind) ? 400 : 502;

    return jsonError(error.message, status, {
      kind: error.kind || 'unknown',
      code: error.code || null,
      // Never retry a bad password or a malformed address — it will fail
      // identically every time and only wastes the daily quota.
      retryable: status === 502 && error.retryable !== false,
      to,
    });
  }
}
