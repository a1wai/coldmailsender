/**
 * lib/dns-auth.js
 * ---------------------------------------------------------------------------
 * Checks whether a sending domain is authenticated: SPF, DKIM, DMARC and MX.
 *
 * These three records are how a receiving server decides the mail really came
 * from you rather than from someone forging your domain. Missing them is the
 * most common reason legitimate cold e-mail lands in spam — more common than
 * anything in the message itself.
 *
 *   SPF   — which servers are allowed to send as this domain
 *   DKIM  — a cryptographic signature on each message
 *   DMARC — what a receiver should do when SPF/DKIM fail, and where to report
 *
 * Server-only: uses `node:dns`.
 */

import dns from 'node:dns/promises';

/**
 * DKIM lives at `<selector>._domainkey.<domain>`, and the selector is chosen by
 * whoever sends the mail — there is no way to enumerate it. These are the
 * selectors the common providers use, which covers most real setups.
 */
const DKIM_SELECTORS = [
  { selector: 'google', provider: 'Google Workspace' },
  { selector: 'default', provider: 'generic' },
  { selector: 'selector1', provider: 'Microsoft 365' },
  { selector: 'selector2', provider: 'Microsoft 365' },
  { selector: 'k1', provider: 'Mailchimp / Mandrill' },
  { selector: 'k2', provider: 'Mailchimp / Mandrill' },
  { selector: 's1', provider: 'SendGrid / generic' },
  { selector: 's2', provider: 'SendGrid / generic' },
  { selector: 'mail', provider: 'generic' },
  { selector: 'dkim', provider: 'generic' },
  { selector: 'zoho', provider: 'Zoho Mail' },
  { selector: 'mandrill', provider: 'Mandrill' },
  { selector: 'sm', provider: 'Brevo / Sendinblue' },
  { selector: 'brevo', provider: 'Brevo' },
  { selector: 'resend', provider: 'Resend' },
  { selector: 'protonmail', provider: 'Proton Mail' },
];

/** Free mailboxes: authenticated by the provider, but not attributable to you. */
const FREE_MAILBOX_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'gmx.com', 'gmx.net', 'mail.com',
  'yandex.com', 'zoho.com', 'proton.me', 'protonmail.com', 'tutanota.com',
]);

const LOOKUP_TIMEOUT_MS = 5000;

/** Wraps a DNS call so one slow record cannot hang the whole audit. */
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} lookup timed out`)), LOOKUP_TIMEOUT_MS)),
  ]);
}

/**
 * Resolves TXT records, distinguishing "no such record" from "the lookup
 * failed". That difference is load-bearing: reporting a timeout as a missing
 * SPF record would send someone off to publish a second one, and a domain with
 * two SPF records fails SPF outright — the advice would break their mail.
 *
 * @returns {Promise<{records: string[], failed: boolean, reason: string|null}>}
 */
async function resolveTxtSafe(name) {
  try {
    const records = await withTimeout(dns.resolveTxt(name), name);
    // Long TXT values arrive split into 255-byte chunks; join before matching.
    return { records: records.map((chunks) => chunks.join('')), failed: false, reason: null };
  } catch (error) {
    // ENOTFOUND / ENODATA mean the name resolves but carries no TXT record —
    // a real answer. Everything else (timeout, SERVFAIL, refused) means we
    // simply do not know.
    const absent = error?.code === 'ENOTFOUND' || error?.code === 'ENODATA';
    return { records: [], failed: !absent, reason: absent ? null : error?.code || error?.message || 'lookup failed' };
  }
}

/** The shape returned for any record we could not determine. */
function unknownRecord(name, reason) {
  return {
    ok: false,
    severity: 'unknown',
    record: null,
    summary: `${name} could not be checked`,
    detail: `The DNS lookup did not complete (${reason}). This is not the same as the record being missing — do not add one on the strength of this result.`,
    fix: 'Re-run the check, or verify the record with your DNS provider directly.',
  };
}

/**
 * Audits a sending domain.
 *
 * @param {string} emailOrDomain  Either `you@example.com` or `example.com`.
 * @returns {Promise<object>} Per-record results plus an overall verdict.
 */
export async function auditSendingDomain(emailOrDomain) {
  const raw = String(emailOrDomain || '').trim().toLowerCase();
  const domain = raw.includes('@') ? raw.split('@').pop() : raw;

  if (!domain || !domain.includes('.')) {
    throw new Error('Enter a sending address or domain first.');
  }

  const isFreeMailbox = FREE_MAILBOX_DOMAINS.has(domain);

  const [mx, spfLookup, dmarcLookup, dkim] = await Promise.all([
    resolveMxSafe(domain),
    resolveTxtSafe(domain),
    resolveTxtSafe(`_dmarc.${domain}`),
    findDkim(domain),
  ]);

  const spf = spfLookup.failed ? unknownRecord('SPF', spfLookup.reason) : analyseSpf(spfLookup.records);
  const dmarc = dmarcLookup.failed ? unknownRecord('DMARC', dmarcLookup.reason) : analyseDmarc(dmarcLookup.records);

  return {
    domain,
    isFreeMailbox,
    mx: {
      ok: mx.length > 0,
      records: mx.slice(0, 5),
      summary: mx.length ? `${mx.length} mail server(s)` : 'No MX records — this domain cannot receive mail',
    },
    spf,
    dkim,
    dmarc,
    verdict: buildVerdict({ isFreeMailbox, domain, spf, dkim, dmarc, hasMx: mx.length > 0 }),
  };
}

async function resolveMxSafe(domain) {
  try {
    const records = await withTimeout(dns.resolveMx(domain), 'MX');
    return records.sort((a, b) => a.priority - b.priority).map((r) => `${r.exchange} (priority ${r.priority})`);
  } catch {
    return [];
  }
}

function analyseSpf(txtRecords) {
  const records = txtRecords.filter((record) => /^v=spf1\b/i.test(record.trim()));

  if (!records.length) {
    return {
      ok: false,
      severity: 'high',
      record: null,
      summary: 'No SPF record',
      detail: 'Receivers cannot verify which servers may send as this domain. Add a TXT record at the root.',
      fix: 'For Google Workspace: TXT record, host "@", value "v=spf1 include:_spf.google.com ~all"',
    };
  }

  // More than one SPF record is a hard failure per RFC 7208, not a warning.
  if (records.length > 1) {
    return {
      ok: false,
      severity: 'high',
      record: records.join(' | '),
      summary: `${records.length} SPF records — that is a permanent error`,
      detail: 'A domain may publish exactly one SPF record. Multiple records make SPF fail outright.',
      fix: 'Merge them into a single "v=spf1 …" record with all the include: mechanisms.',
    };
  }

  const record = records[0];
  const all = record.match(/([~\-+?])all\b/);
  // `redirect=` hands the whole policy — including the `all` handling — to
  // another domain, so a record using it correctly has no `all` of its own.
  const hasRedirect = /\bredirect=/i.test(record);

  let severity = 'ok';
  let detail = 'SPF is published and looks valid.';
  let fix = null;

  if (!all && hasRedirect) {
    detail = 'SPF delegates to another domain via redirect=, which supplies the policy. That is valid.';
  } else if (!all) {
    severity = 'medium';
    detail = 'The record has no "all" mechanism, so it never states what to do with unlisted senders.';
    fix = 'Append "~all" (soft fail) or "-all" (hard fail).';
  } else if (all[1] === '+') {
    severity = 'high';
    detail = '"+all" authorises the entire internet to send as this domain. It is worse than having no SPF at all.';
    fix = 'Change "+all" to "~all".';
  } else if (all[1] === '?') {
    severity = 'medium';
    detail = '"?all" is neutral and gives receivers nothing to act on.';
    fix = 'Change "?all" to "~all".';
  }

  // Each include/redirect costs a DNS lookup; over 10 and SPF permerrors.
  const lookups = (record.match(/\b(include|a|mx|ptr|exists|redirect)[:=]/gi) || []).length;
  if (lookups > 10) {
    severity = 'high';
    detail += ` The record needs ${lookups} DNS lookups; the limit is 10, above which SPF fails permanently.`;
    fix = 'Flatten or remove some include: mechanisms.';
  }

  return { ok: severity === 'ok', severity, record, summary: severity === 'ok' ? 'SPF published' : 'SPF needs attention', detail, fix };
}

async function findDkim(domain) {
  const checks = await Promise.all(
    DKIM_SELECTORS.map(async ({ selector, provider }) => {
      const { records, failed } = await resolveTxtSafe(`${selector}._domainkey.${domain}`);
      const found = records.find((record) => /v=dkim1|p=/i.test(record));
      return found ? { selector, provider, record: found } : { failed };
    }),
  );

  const found = checks.filter((entry) => entry.record);
  const failures = checks.filter((entry) => entry.failed).length;

  // If most selector lookups errored rather than returning "no such record",
  // we cannot claim DKIM is absent.
  if (!found.length && failures > DKIM_SELECTORS.length / 2) {
    return {
      ok: false,
      severity: 'unknown',
      found: [],
      summary: 'DKIM could not be checked',
      detail: `${failures} of ${DKIM_SELECTORS.length} selector lookups failed, so this is inconclusive — not evidence that DKIM is missing.`,
      fix: 'Re-run the check, or confirm DKIM in your mail provider.',
    };
  }

  if (!found.length) {
    return {
      ok: false,
      severity: 'high',
      found: [],
      summary: 'No DKIM found',
      // Worth stating plainly — a false negative here is entirely possible.
      detail:
        `None of the ${DKIM_SELECTORS.length} common selectors resolved. DKIM may still be configured under a ` +
        'custom selector this check cannot guess — confirm in your mail provider before assuming it is missing.',
      fix: 'Google Workspace: Admin console → Apps → Google Workspace → Gmail → Authenticate email → Generate new record.',
    };
  }

  // An empty p= is how a key is revoked; it counts as broken, not present.
  const revoked = found.filter((entry) => /(^|;)\s*p=\s*(;|$)/.test(entry.record));
  if (revoked.length === found.length) {
    return {
      ok: false,
      severity: 'high',
      found,
      summary: 'DKIM key is revoked',
      detail: `Selector "${revoked[0].selector}" publishes an empty public key, which explicitly revokes it.`,
      fix: 'Generate and publish a new DKIM key with your provider.',
    };
  }

  return {
    ok: true,
    severity: 'ok',
    found,
    summary: `DKIM published (${found.map((entry) => entry.selector).join(', ')})`,
    detail: `Signing key found for ${found[0].provider}.`,
    fix: null,
  };
}

function analyseDmarc(txtRecords) {
  const record = txtRecords.find((entry) => /^v=dmarc1\b/i.test(entry.trim()));

  if (!record) {
    return {
      ok: false,
      severity: 'high',
      record: null,
      policy: null,
      summary: 'No DMARC record',
      detail:
        'Since February 2024 Gmail and Yahoo require DMARC from bulk senders. Without it, mail to their users is ' +
        'throttled or rejected.',
      fix: 'Add a TXT record at "_dmarc" with value "v=DMARC1; p=none; rua=mailto:you@yourdomain.com" and tighten to p=quarantine once reports look clean.',
    };
  }

  const policy = (record.match(/\bp=(none|quarantine|reject)\b/i) || [])[1]?.toLowerCase() || null;
  const hasReporting = /\brua=/i.test(record);

  if (!policy) {
    return {
      ok: false,
      severity: 'medium',
      record,
      policy: null,
      summary: 'DMARC record has no policy',
      detail: 'The "p=" tag is required; without it the record is ignored.',
      fix: 'Add "p=none" to start.',
    };
  }

  return {
    ok: true,
    severity: policy === 'none' ? 'low' : 'ok',
    record,
    policy,
    summary: `DMARC published (p=${policy})`,
    detail:
      policy === 'none'
        ? 'p=none is monitor-only: it satisfies the bulk-sender requirement but tells receivers to take no action on failures.'
        : `p=${policy} is an enforcing policy — good.`,
    fix:
      policy === 'none'
        ? 'Once your reports look clean, move to "p=quarantine".'
        : hasReporting
          ? null
          : 'Consider adding "rua=mailto:…" so you receive aggregate reports.',
  };
}

function buildVerdict({ isFreeMailbox, domain, spf, dkim, dmarc, hasMx }) {
  if (isFreeMailbox) {
    return {
      level: 'warn',
      headline: `${domain} is a free mailbox`,
      detail:
        'Your mail is authenticated by the provider, so SPF and DKIM technically pass — but the domain is not yours, ' +
        'you share its reputation with millions of other users, and bulk cold outreach from it is filtered hard. ' +
        'This is the most common reason cold e-mail lands in spam, and no amount of message tuning fixes it. ' +
        'Sending from your own domain is the fix.',
    };
  }

  if (!hasMx) {
    return {
      level: 'error',
      headline: `${domain} has no MX records`,
      detail: 'The domain cannot receive mail, so replies and bounce reports go nowhere. Receivers treat that as a strong spam signal.',
    };
  }

  const passing = [spf.ok, dkim.ok, dmarc.ok].filter(Boolean).length;

  // A record we could not look up is not a missing record — never report an
  // inconclusive check as a finding the user should act on.
  const unknown = [spf, dkim, dmarc].filter((entry) => entry.severity === 'unknown');
  const missing = [!spf.ok && spf.severity !== 'unknown' && 'SPF',
                   !dkim.ok && dkim.severity !== 'unknown' && 'DKIM',
                   !dmarc.ok && dmarc.severity !== 'unknown' && 'DMARC'].filter(Boolean);

  if (passing === 3) {
    return {
      level: 'ok',
      headline: 'Fully authenticated',
      detail: 'SPF, DKIM and DMARC are all published. Content and sending behaviour are what matter from here.',
    };
  }

  if (!missing.length && unknown.length) {
    return {
      level: 'warn',
      headline: 'Check inconclusive',
      detail:
        `${unknown.length} record lookup(s) did not complete, so this run cannot say whether they are published. ` +
        'Re-run the check rather than adding records on the strength of it — a duplicate SPF record breaks SPF entirely.',
    };
  }

  return {
    level: passing === 0 && !unknown.length ? 'error' : 'warn',
    headline: `Missing ${missing.join(' and ')}`,
    detail:
      `${passing} of 3 authentication records confirmed. Each missing record measurably increases the chance of ` +
      'being filtered, and Gmail and Yahoo now require all three from anyone sending in volume.' +
      (unknown.length ? ` (${unknown.length} could not be checked this run.)` : ''),
  };
}
