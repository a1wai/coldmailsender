/**
 * POST /api/test-smtp
 * ---------------------------------------------------------------------------
 * Verifies SMTP credentials without sending anything — the "Test Connection"
 * button in Tab 4. Optionally sends a single test message back to the user's
 * own address so they can confirm formatting and deliverability end to end.
 *
 * Request:
 *   {
 *     credentials?: { user, pass, fromName, host, port, secure },
 *     sendTestEmail?: boolean          // default false — verify only
 *   }
 *
 * Response:
 *   { ok: true, message, host, port, secure, user, testEmailSent? }
 *   { ok: false, error }
 *
 * The password is used for exactly this request and is never written to disk
 * or logged. `GET` reports which server-side env vars are configured (without
 * revealing their values) so the UI can show "using server credentials".
 */

import { verifyConnection, resolveCredentials, sendMail } from '@/lib/mailer';
import { jsonOk, jsonError, readJsonBody, rateLimit, clientKey } from '@/lib/http';
import { isFirecrawlEnabled } from '@/lib/adapters/firecrawl';
import { isQStashEnabled } from '@/lib/adapters/qstash';
import { isSupabaseEnabled } from '@/lib/adapters/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request) {
  // A failing SMTP handshake is slow and Google throttles repeated auth
  // failures, so keep this tight.
  const limit = rateLimit(`smtp-test:${clientKey(request)}`, { limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonError(`Too many connection tests. Wait ${limit.retryAfter}s.`, 429, {
      retryAfter: limit.retryAfter,
    });
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch (error) {
    return jsonError(error.message, error.status || 400);
  }

  const { credentials = {}, sendTestEmail = false } = body;

  try {
    const result = await verifyConnection(credentials);

    if (!result.ok) return jsonError(result.message, 400, { problems: result.problems || [] });

    if (!sendTestEmail) return jsonOk(result);

    // Send the probe to the authenticated account itself — never to a third
    // party, so a test can't be abused to mail an arbitrary address.
    const creds = resolveCredentials(credentials);

    try {
      const sent = await sendMail({
        credentials,
        to: creds.user,
        subject: 'Test — Cold Email Sender is connected',
        html:
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">' +
          '<p style="margin:0 0 16px 0;">Your SMTP configuration works.</p>' +
          `<p style="margin:0 0 16px 0;">Sent via <strong>${escapeHtml(creds.host)}:${creds.port}</strong> as <strong>${escapeHtml(creds.user)}</strong>.</p>` +
          '<p style="margin:0;color:#6b7280;font-size:13px;">Cold Email Sender — built by @a1wai</p>' +
          '</div>',
        // No footer on a self-addressed diagnostic message.
        compliance: { appendFooter: false },
      });

      return jsonOk({ ...result, testEmailSent: true, messageId: sent.messageId, testEmailTo: creds.user });
    } catch (error) {
      // Auth succeeded but the send failed — report both facts clearly.
      return jsonOk({
        ...result,
        testEmailSent: false,
        testEmailError: error.message,
        message: `${result.message} The connection is fine, but the test message could not be sent: ${error.message}`,
      });
    }
  } catch (error) {
    console.error('[api/test-smtp] Verification failed:', error.message);
    return jsonError(error.message || 'Could not verify the SMTP connection.', 500);
  }
}

/**
 * GET /api/test-smtp
 * Reports which optional integrations are configured server-side. Returns only
 * booleans and the sender address — never a secret.
 */
export async function GET() {
  const creds = resolveCredentials();

  return jsonOk({
    server: {
      smtpConfigured: Boolean(creds.user && creds.pass),
      smtpUser: creds.user || null,
      smtpHost: creds.host,
      smtpPort: creds.port,
      firecrawl: isFirecrawlEnabled(),
      qstash: isQStashEnabled(),
      supabase: isSupabaseEnabled(),
      postalAddress: Boolean(process.env.SENDER_POSTAL_ADDRESS),
      unsubscribe: Boolean(process.env.UNSUBSCRIBE_URL || process.env.UNSUBSCRIBE_EMAIL),
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
