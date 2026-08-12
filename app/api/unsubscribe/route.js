/**
 * /api/unsubscribe
 * ---------------------------------------------------------------------------
 * The endpoint behind the `List-Unsubscribe` header.
 *
 *   POST  RFC 8058 one-click. Gmail, Yahoo and Apple Mail POST
 *         `List-Unsubscribe=One-Click` here when the recipient taps the
 *         "Unsubscribe" link the client renders next to the sender name. No
 *         confirmation, no page — record it and return 200 quickly.
 *
 *   GET   A human clicked the link in the footer. This deliberately does NOT
 *         opt them out: link scanners and mail-client prefetchers issue GETs
 *         on every URL in a message, and honouring those would silently
 *         suppress people who never asked. It renders a confirm button that
 *         POSTs instead.
 *
 * Where the opt-out is recorded depends on what is configured:
 *   - Supabase, when set up — the durable record, survives browsers.
 *   - An e-mail to the sender, when server SMTP credentials exist — so the
 *     opt-out reaches a human even with no database at all.
 *   - The server log, always.
 *
 * The browser also keeps its own opt-out list, which the campaign tab filters
 * against before every send.
 */

import { decodeOptOutToken } from '@/lib/unsubscribe';
import { recordUnsubscribe, isSupabaseEnabled } from '@/lib/adapters/supabase';
import { resolveCredentials, sendMail } from '@/lib/mailer';
import { rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// POST — one-click
// ---------------------------------------------------------------------------

export async function POST(request) {
  // Generous: a legitimate mail provider may fire several of these at once
  // when someone clears a backlog, but this also caps token-guessing.
  const limit = rateLimit(`unsub:${clientKey(request)}`, { limit: 30, windowMs: 60_000 });
  if (!limit.allowed) {
    return new Response('Too many requests.', { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
  }

  const url = new URL(request.url);
  let token = url.searchParams.get('t') || '';

  // One-click posts an `application/x-www-form-urlencoded` body; some clients
  // put the token there rather than on the query string.
  if (!token) {
    try {
      const body = await request.text();
      token = new URLSearchParams(body).get('t') || '';
    } catch {
      /* the query string was the only chance */
    }
  }

  // Set when the POST came from the confirm button on the GET page rather than
  // from a mail client, so a person gets a page back instead of bare text.
  const wantsPage = url.searchParams.get('redirect') === '1';
  const decoded = decodeOptOutToken(token);

  if (!decoded.ok) {
    // Never leak which tokens are real. A mail client showing "unsubscribe
    // failed" is worse than a silent success, so answer 200 either way and log
    // the reason server-side.
    console.warn('[api/unsubscribe] Rejected token:', decoded.reason);
  } else {
    await applyOptOut(decoded, wantsPage ? 'confirmation page' : 'one-click');
  }

  if (wantsPage) {
    // 303 so a refresh does not re-POST.
    return new Response(null, {
      status: 303,
      headers: { Location: '/api/unsubscribe?done=1', 'Cache-Control': 'no-store' },
    });
  }

  return plain('You have been unsubscribed.', 200);
}

// ---------------------------------------------------------------------------
// GET — the human-facing page
// ---------------------------------------------------------------------------

export async function GET(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || '';
  const done = url.searchParams.get('done') === '1';
  const decoded = decodeOptOutToken(token);

  if (done) {
    return page({
      heading: 'You have been unsubscribed',
      body: 'You will not be contacted from this list again. Nothing else is stored about you.',
    });
  }

  if (!decoded.ok) {
    return page({
      heading: 'This link is not valid',
      body:
        `${decoded.reason || 'The link could not be read.'} ` +
        'If you are still receiving mail you did not ask for, reply to the message with the word "unsubscribe" ' +
        'and it will be handled by hand.',
    });
  }

  return page({
    heading: 'Unsubscribe',
    body: `Confirm that <strong>${escapeHtml(decoded.email)}</strong> should be removed from this list.`,
    // A form POST rather than a link: prefetchers follow links, not forms.
    action: `/api/unsubscribe?t=${encodeURIComponent(token)}&redirect=1`,
  });
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

async function applyOptOut(decoded, source) {
  const { email, sender, verified } = decoded;

  console.log(`[api/unsubscribe] ${email} opted out via ${source} (signed: ${verified})`);

  const tasks = [];

  if (isSupabaseEnabled()) {
    tasks.push(recordUnsubscribe({ email, sender, source }));
  }

  // Tell the sender, so the opt-out is actionable even with no database. Only
  // possible with server-side SMTP credentials — UI-supplied ones live in the
  // sender's browser and are not available on an inbound request like this.
  const creds = resolveCredentials();
  if (creds.user && creds.pass) {
    tasks.push(
      sendMail({
        to: creds.user,
        subject: `Unsubscribe request: ${email}`,
        html:
          '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">' +
          `<p><strong>${escapeHtml(email)}</strong> has unsubscribed.</p>` +
          `<p style="color:#6b7280;font-size:13px;">Source: ${escapeHtml(source)}${sender ? ` · sent from ${escapeHtml(sender)}` : ''}</p>` +
          '<p style="color:#6b7280;font-size:13px;">Add them to the opt-out list in the Send tab so they are excluded from future campaigns.</p>' +
          '</div>',
        compliance: { appendFooter: false },
      }),
    );
  }

  // Never let a notification failure turn into a failed unsubscribe — from the
  // recipient's side the opt-out must always appear to have worked.
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[api/unsubscribe] Side-effect failed:', result.reason?.message || result.reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function plain(text, status) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * A single self-contained page. No shared layout on purpose: this is rendered
 * for a stranger who is annoyed enough to be unsubscribing, and it should load
 * instantly and work with JavaScript disabled.
 */
function page({ heading, body, action }) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #0a0b0f; color: #e2e8f0;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 460px; width: 100%; padding: 32px; border-radius: 20px;
         border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.03); }
  h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
  p { margin: 0 0 20px; color: #94a3b8; }
  button { width: 100%; padding: 12px 18px; font: inherit; font-weight: 600; cursor: pointer;
           color: #fff; background: #4f46e5; border: 0; border-radius: 12px; }
  button:hover { background: #4338ca; }
  footer { margin-top: 22px; font-size: 12px; color: #64748b; }
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(heading)}</h1>
    <p>${body}</p>
    ${action ? `<form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe me</button></form>` : ''}
    <footer>Cold Email Sender</footer>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
