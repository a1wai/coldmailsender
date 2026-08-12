/**
 * lib/mailer.js
 * ---------------------------------------------------------------------------
 * Thin, well-behaved wrapper around `nodemailer`.
 *
 * Two credential sources are supported, in priority order:
 *   1. Credentials passed in from the UI (Settings) — nothing is stored server-side.
 *   2. `SMTP_*` environment variables — secrets never touch the browser.
 *
 * Server-only. Requires the Node.js runtime.
 */

import nodemailer from 'nodemailer';
import { MAX_ATTACHMENT_BYTES } from './constants.js';

/** Gmail's submission endpoint. Overridable for Zoho, Brevo, Mailgun, etc. */
const GMAIL_DEFAULTS = { host: 'smtp.gmail.com', port: 465, secure: true };

/** Loose but effective address validation — mirrors the scraper's regex. */
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}$/;

// Re-exported so server-side callers can keep importing it from the mailer.
export { MAX_ATTACHMENT_BYTES };

export function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

/**
 * Merges UI-supplied credentials with environment defaults.
 *
 * Google displays app passwords as four space-separated groups ("abcd efgh
 * ijkl mnop"); users paste them verbatim, so strip whitespace rather than
 * making them fix the formatting themselves.
 */
export function resolveCredentials(input = {}) {
  const user = (input.user || process.env.SMTP_USER || '').trim();
  const pass = (input.pass || process.env.SMTP_PASS || '').replace(/\s+/g, '');

  const portValue = input.port ?? process.env.SMTP_PORT ?? GMAIL_DEFAULTS.port;
  const port = Number(portValue) || GMAIL_DEFAULTS.port;

  // Implicit TLS on 465, STARTTLS on 587/25.
  const secureRaw = input.secure ?? process.env.SMTP_SECURE;
  const secure = secureRaw === undefined || secureRaw === '' ? port === 465 : String(secureRaw) === 'true' || secureRaw === true;

  return {
    user,
    pass,
    host: (input.host || process.env.SMTP_HOST || GMAIL_DEFAULTS.host).trim(),
    port,
    secure,
    fromName: (input.fromName || process.env.SMTP_FROM_NAME || '').trim(),
    replyTo: (input.replyTo || process.env.SMTP_REPLY_TO || '').trim(),
  };
}

/** Returns an array of human-readable problems; empty means good to go. */
export function validateCredentials(creds) {
  const problems = [];

  if (!creds.user) problems.push('Sender e-mail address is missing.');
  else if (!isValidEmail(creds.user)) problems.push(`"${creds.user}" is not a valid e-mail address.`);

  if (!creds.pass) problems.push('App password is missing.');
  else if (/gmail\.com$/i.test(creds.user) && creds.pass.length !== 16) {
    // Not fatal — Workspace accounts occasionally differ — but almost always
    // means the user pasted their account password instead of an app password.
    problems.push(
      `Gmail app passwords are exactly 16 characters; got ${creds.pass.length}. ` +
        'Generate one at https://myaccount.google.com/apppasswords — your normal account password will not work.',
    );
  }

  if (!creds.host) problems.push('SMTP host is missing.');
  if (!creds.port || creds.port < 1 || creds.port > 65535) problems.push('SMTP port is invalid.');

  return problems;
}

/**
 * Builds a transporter. Connections are pooled so a campaign reuses one TCP
 * session instead of re-authenticating for every message, and rate-limited to
 * stay well inside Gmail's per-connection thresholds.
 */
export function createTransport(creds) {
  return nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    rateDelta: 1000,
    rateLimit: 1,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,

    // Nodemailer stamps `X-Mailer: nodemailer (x.y.z; …)` on every message by
    // default. That header appears on effectively no mail a human sends, and
    // filters use it as a bulk-sender fingerprint — turning it off is a free
    // deliverability win.
    xMailer: false,

    // Attachments only ever arrive as base64 from the browser, so nothing
    // should be resolving a local path or fetching a URL. Closing both off
    // removes a file-read / SSRF surface from user-supplied attachment data.
    disableFileAccess: true,
    disableUrlAccess: true,

    tls: {
      // Explicit: never silently accept an invalid certificate.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
  });
}

/**
 * Opens a connection and authenticates without sending anything.
 * Used by the "Test Connection" button in Settings.
 */
export async function verifyConnection(input = {}) {
  const creds = resolveCredentials(input);
  const problems = validateCredentials(creds);

  if (problems.length) {
    return { ok: false, message: problems.join(' '), problems };
  }

  const transporter = createTransport(creds);

  try {
    await transporter.verify();
    return {
      ok: true,
      message: `Connected to ${creds.host}:${creds.port} as ${creds.user}.`,
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      user: creds.user,
    };
  } catch (error) {
    return { ok: false, message: describeSmtpError(error), code: error?.code || null };
  } finally {
    transporter.close();
  }
}

/**
 * Sends exactly one message.
 *
 * One message per invocation is deliberate: it keeps every serverless call far
 * below Vercel's execution limit and lets the client pace sends precisely. The
 * batching logic lives in `lib/queue.js`.
 *
 * @param {object} params
 * @param {object} params.credentials  UI credentials (merged with env).
 * @param {string} params.to           Recipient address.
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.text]       Plain-text alternative (auto-derived if omitted).
 * @param {Array}  [params.attachments] `[{ filename, content /* base64 *\/, contentType }]`
 * @param {object} [params.compliance] `{ postalAddress, unsubscribeEmail, unsubscribeUrl, appendFooter }`
 */
export async function sendMail({
  credentials = {},
  to,
  subject,
  html,
  text,
  attachments = [],
  compliance = {},
}) {
  const creds = resolveCredentials(credentials);
  const problems = validateCredentials(creds);
  if (problems.length) {
    const error = new Error(problems.join(' '));
    error.kind = 'credentials';
    throw error;
  }

  if (!isValidEmail(String(to || '').trim())) {
    const error = new Error(`"${to}" is not a valid recipient address.`);
    error.kind = 'recipient';
    throw error;
  }

  if (!subject || !String(subject).trim()) {
    const error = new Error('Subject is empty.');
    error.kind = 'content';
    throw error;
  }

  if (!html || !String(html).trim()) {
    const error = new Error('Message body is empty.');
    error.kind = 'content';
    throw error;
  }

  const prepared = prepareAttachments(attachments);
  const footer = buildComplianceFooter(compliance, creds);

  const transporter = createTransport(creds);

  try {
    const info = await transporter.sendMail({
      from: creds.fromName ? { name: creds.fromName, address: creds.user } : creds.user,
      to: String(to).trim(),
      replyTo: creds.replyTo || undefined,
      subject: String(subject).trim(),
      html: html + footer.html,
      text: (text || htmlToText(html)) + footer.text,
      attachments: prepared,
      headers: footer.headers,
    });

    return {
      ok: true,
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      response: info.response,
    };
  } catch (error) {
    const wrapped = new Error(describeSmtpError(error));
    wrapped.kind = 'smtp';
    wrapped.code = error?.code || null;
    wrapped.responseCode = error?.responseCode || null;
    // 4xx SMTP codes are transient (greylisting, throughput) and worth retrying;
    // 5xx are permanent and a retry just burns quota.
    wrapped.retryable = isRetryable(error);
    throw wrapped;
  } finally {
    transporter.close();
  }
}

/**
 * Converts base64 payloads from the browser into nodemailer attachments,
 * enforcing the total size budget.
 */
export function prepareAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];

  let total = 0;

  return attachments.map((file) => {
    // Accept both a raw base64 string and a `data:` URL from FileReader.
    const raw = String(file.content || '');
    const base64 = raw.includes(',') && raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;

    // 4 base64 characters encode 3 bytes.
    const bytes = Math.floor((base64.length * 3) / 4);
    total += bytes;

    if (total > MAX_ATTACHMENT_BYTES) {
      const error = new Error(
        `Attachments exceed the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB limit. ` +
          'Host large files (a reel, a deck) and send a link instead — it also lands in the inbox more reliably.',
      );
      error.kind = 'attachment';
      throw error;
    }

    return {
      filename: file.filename || 'attachment',
      content: base64,
      encoding: 'base64',
      contentType: file.contentType || undefined,
    };
  });
}

/**
 * Appends the legally-required footer and the List-Unsubscribe headers.
 *
 * CAN-SPAM (US), CASL (Canada), PECR/GDPR (EU/UK) all require a working opt-out
 * and a physical postal address on unsolicited commercial mail. `List-Unsubscribe`
 * is not merely compliance decoration — Gmail and Outlook both weigh it when
 * deciding between the inbox and the spam folder.
 */
export function buildComplianceFooter(compliance = {}, creds = {}) {
  const postalAddress = compliance.postalAddress || process.env.SENDER_POSTAL_ADDRESS || '';
  const unsubscribeEmail = compliance.unsubscribeEmail || process.env.UNSUBSCRIBE_EMAIL || creds.user || '';
  const unsubscribeUrl = compliance.unsubscribeUrl || process.env.UNSUBSCRIBE_URL || '';
  const appendFooter = compliance.appendFooter !== false;

  const headers = {};
  const unsubscribeTargets = [];

  if (unsubscribeUrl) unsubscribeTargets.push(`<${unsubscribeUrl}>`);
  if (unsubscribeEmail && isValidEmail(unsubscribeEmail)) {
    unsubscribeTargets.push(`<mailto:${unsubscribeEmail}?subject=Unsubscribe>`);
  }

  if (unsubscribeTargets.length) {
    headers['List-Unsubscribe'] = unsubscribeTargets.join(', ');
    // Only advertise one-click when an HTTPS endpoint exists — RFC 8058
    // one-click is not defined over mailto.
    if (unsubscribeUrl) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  if (!appendFooter) return { html: '', text: '', headers };

  const optOutHtml = unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">unsubscribe here</a>`
    : unsubscribeEmail
      ? `reply with "unsubscribe"`
      : '';

  const lines = [];
  const textLines = [];

  if (optOutHtml) {
    lines.push(`You received this because I thought it was relevant to your business. If not, ${optOutHtml} and I won't contact you again.`);
    textLines.push(
      unsubscribeUrl
        ? `You received this because I thought it was relevant to your business. To opt out: ${unsubscribeUrl}`
        : `You received this because I thought it was relevant to your business. Reply "unsubscribe" and I won't contact you again.`,
    );
  }

  if (postalAddress) {
    lines.push(escapeHtml(postalAddress));
    textLines.push(postalAddress);
  }

  if (!lines.length) return { html: '', text: '', headers };

  const html =
    `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e5e7eb;` +
    `font-size:12px;line-height:1.5;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">` +
    lines.join('<br>') +
    `</div>`;

  return { html, text: `\n\n---\n${textLines.join('\n')}\n`, headers };
}

/** Rough HTML → text fallback for the plain-text MIME part. */
export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRetryable(error) {
  const code = error?.responseCode;
  if (typeof code === 'number') return code >= 400 && code < 500;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(error?.code);
}

/** Turns nodemailer's terse errors into something a user can act on. */
export function describeSmtpError(error) {
  const code = error?.code;
  const response = String(error?.response || error?.message || '');

  if (code === 'EAUTH' || /535|534|Username and Password not accepted/i.test(response)) {
    return (
      'Authentication failed. For Gmail: enable 2-Step Verification, then create a 16-character ' +
      'app password at https://myaccount.google.com/apppasswords and use that — your normal ' +
      'account password will always be rejected.'
    );
  }

  if (/534.*Application-specific password required/i.test(response)) {
    return 'Google requires an app-specific password for this account. Create one at https://myaccount.google.com/apppasswords.';
  }

  if (/535.*BadCredentials/i.test(response)) {
    return 'Google rejected the credentials. Double-check the address and regenerate the app password.';
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION') {
    return `Could not reach the SMTP server (${code}). Check the host and port — Gmail is smtp.gmail.com:465 with SSL, or :587 with STARTTLS. Some networks block outbound SMTP entirely.`;
  }

  if (code === 'EDNS' || /getaddrinfo/i.test(response)) {
    return 'The SMTP hostname could not be resolved. Check for a typo in the host field.';
  }

  if (error?.responseCode === 550 || /550/.test(response)) {
    return `The server rejected the recipient (550). The address may not exist. ${response}`.trim();
  }

  if (error?.responseCode === 552 || error?.responseCode === 523) {
    return 'The message was rejected for being too large. Reduce or remove attachments.';
  }

  if (/Daily user sending (quota|limit) exceeded|4\.7\.0.*too many/i.test(response)) {
    return 'Gmail daily sending limit reached (500/day for free accounts, 2,000 for Workspace). Resume tomorrow.';
  }

  if (error?.responseCode === 454 || /4\.7\.0/.test(response)) {
    return `Temporary throttling by the mail server. Increase the delay between sends and retry. ${response}`.trim();
  }

  return response || 'Unknown SMTP error.';
}
