/**
 * lib/spam-check.js
 * ---------------------------------------------------------------------------
 * Analyses a message for the things that push cold e-mail into the spam
 * folder. Pure content analysis, no network — isomorphic, so the editor can
 * warn live and the campaign pre-flight can block on the same findings.
 *
 * Honest framing: no checker can promise inbox placement. Spam filtering is
 * driven mostly by *sender reputation* — has this domain sent mail people
 * wanted before? — and content is the smaller half. What this catches is the
 * self-inflicted part: the phrasing, formatting and link patterns that get a
 * message filtered even when the sender is fine. The domain-authentication
 * half lives in `lib/dns-auth.js`, and that is usually the bigger win.
 */

/**
 * Phrases filters have been trained on for two decades. Weighted, because
 * "free" in passing is not "ACT NOW 100% FREE GUARANTEE".
 */
const SPAM_PHRASES = [
  // High — these alone can tip a message
  { re: /\b(act now|limited time offer|urgent(ly)? (reply|respond)|apply now)\b/i, weight: 3, hint: 'urgency pressure' },
  { re: /\b(100% (free|guaranteed?)|risk[- ]free|no (risk|obligation|catch)|money[- ]back)\b/i, weight: 3, hint: 'guarantee language' },
  { re: /\b(click here|click below|buy now|order now|subscribe now)\b/i, weight: 3, hint: 'hard call-to-action' },
  { re: /\b(winner|congratulations|you('| ha)ve been selected|claim your)\b/i, weight: 3, hint: 'prize language' },
  { re: /\b(make money|extra cash|earn \$|income opportunity|financial freedom)\b/i, weight: 3, hint: 'income claims' },
  { re: /\b(viagra|casino|crypto ?(giveaway|airdrop)|forex signals)\b/i, weight: 4, hint: 'classic spam vertical' },

  // Medium — fine once, a problem stacked
  { re: /\b(free (trial|gift|offer|consultation))\b/i, weight: 2, hint: '"free" offer' },
  { re: /\b(guarantee[ds]?|best price|lowest price|cheap(est)?|discount)\b/i, weight: 2, hint: 'sales language' },
  { re: /\b(dear (sir|madam|friend|customer)|to whom it may concern)\b/i, weight: 2, hint: 'impersonal greeting' },
  { re: /\b(this is not spam|not a spam|unsubscribe below to stop)\b/i, weight: 4, hint: 'protesting innocence reads as guilt' },
  { re: /\b(increase (your )?(sales|revenue|traffic) by \d+%?)\b/i, weight: 2, hint: 'unverifiable numeric claim' },

  // Low — worth knowing about
  { re: /\b(opportunity|exclusive|amazing|incredible|revolutionary|game[- ]chang(er|ing))\b/i, weight: 1, hint: 'hype word' },
  { re: /\b(no credit card|credit card required|pre[- ]approved)\b/i, weight: 2, hint: 'payment language' },
];

/** Shorteners hide the destination, which is exactly why filters distrust them. */
const URL_SHORTENERS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in',
];

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/**
 * Runs every content check.
 *
 * @param {object} message
 * @param {string} message.subject
 * @param {string} message.body        Plain-text body (pre-render is fine).
 * @param {string} [message.fromEmail]
 * @param {number} [message.attachmentCount]
 * @param {boolean} [message.hasUnsubscribe]
 * @param {boolean} [message.hasPostalAddress]
 * @returns {{ score: number, grade: string, findings: Array }}
 */
export function analyseMessage({
  subject = '',
  body = '',
  fromEmail = '',
  attachmentCount = 0,
  hasUnsubscribe = true,
  hasPostalAddress = true,
} = {}) {
  const findings = [];
  const add = (severity, title, detail, fix) => findings.push({ severity, title, detail, fix });

  const text = `${subject}\n${body}`;
  const words = body.split(/\s+/).filter(Boolean);

  // ---------------------------------------------------------------- subject
  const trimmedSubject = subject.trim();

  if (!trimmedSubject) {
    add('high', 'No subject line', 'Messages with an empty subject are filtered almost universally.', 'Write a short, specific subject.');
  } else {
    if (trimmedSubject.length > 60) {
      add('low', 'Subject is long', `${trimmedSubject.length} characters — mobile clients truncate around 40.`, 'Aim for under 50 characters.');
    }
    // The second test needs /i too — without it "Re: real subject" (capital R)
    // failed the "looks genuine" check and every real follow-up was flagged.
    if (/^(re|fwd?):/i.test(trimmedSubject) && !/^(re|fwd?):\s*\S/i.test(trimmedSubject)) {
      add('medium', 'Fake "Re:" prefix', 'Faking a reply to a conversation that never happened is a strong spam signal and annoys recipients.', 'Only use "Re:" on a genuine follow-up to your own earlier message.');
    }
    if (isMostlyUpperCase(trimmedSubject)) {
      add('high', 'Subject is in capitals', 'Shouting is one of the oldest spam heuristics there is.', 'Use normal sentence case — lower-case subjects perform best in cold outreach.');
    }
    if (/[!?]{2,}|!{1,}\s*$/.test(trimmedSubject)) {
      add('medium', 'Exclamation marks in the subject', 'Filters weight punctuation in subjects heavily.', 'Remove them.');
    }
    // Emoji: fine for newsletters people opted into, risky from a stranger.
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(trimmedSubject)) {
      add('low', 'Emoji in the subject', 'Reads as marketing to a recipient who has never heard from you.', 'Drop it for first contact.');
    }
  }

  // ------------------------------------------------------------------- body
  if (words.length < 20) {
    add('medium', 'Body is very short', `${words.length} words. Very short messages with a link look like a phishing pattern.`, 'Two or three sentences of real context.');
  } else if (words.length > 250) {
    add('medium', 'Body is long', `${words.length} words. Long cold e-mail is read less and filtered more.`, 'Cut to under 150 words — one reason for writing and one ask.');
  }

  const capsWords = words.filter((word) => word.length > 3 && isMostlyUpperCase(word) && /[A-Z]/.test(word));
  if (capsWords.length > 2) {
    add('medium', 'Words in ALL CAPS', `${capsWords.length} of them (${capsWords.slice(0, 3).join(', ')}…).`, 'Use bold or plain emphasis instead.');
  }

  const exclamations = (body.match(/!/g) || []).length;
  if (exclamations > 2) {
    add('medium', 'Lots of exclamation marks', `${exclamations} in the body.`, 'One at most.');
  }

  // ------------------------------------------------------------------ links
  const links = body.match(/https?:\/\/[^\s<>")]+/gi) || [];

  if (links.length > 3) {
    add('high', 'Too many links', `${links.length} links. More than two in a first cold e-mail is a strong filter signal.`, 'Keep one link — the single thing you want them to look at.');
  } else if (links.length === 3) {
    add('low', 'Three links', 'Two or fewer is safer for first contact.', 'Consider trimming one.');
  }

  const shortened = links.filter((link) => URL_SHORTENERS.some((host) => link.toLowerCase().includes(host)));
  if (shortened.length) {
    add('high', 'Shortened links', `${shortened.length} shortener link(s). These hide the destination, so filters treat them as suspicious by default.`, 'Link to the real URL — a Drive or YouTube link is fine as-is.');
  }

  // A raw IP address in a URL is almost exclusively a phishing pattern.
  if (links.some((link) => /https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(link))) {
    add('high', 'Link to a bare IP address', 'Effectively a phishing signature.', 'Use a domain name.');
  }

  // ---------------------------------------------------------------- phrases
  let phraseScore = 0;
  const matchedPhrases = [];

  for (const { re, weight, hint } of SPAM_PHRASES) {
    const match = text.match(re);
    if (match) {
      phraseScore += weight;
      matchedPhrases.push({ phrase: match[0], hint, weight });
    }
  }

  if (matchedPhrases.length) {
    const severity = phraseScore >= 6 ? 'high' : phraseScore >= 3 ? 'medium' : 'low';
    add(
      severity,
      `${matchedPhrases.length} spam-trigger phrase${matchedPhrases.length === 1 ? '' : 's'}`,
      matchedPhrases.map((entry) => `"${entry.phrase}" (${entry.hint})`).join(', '),
      'Rewrite in plain language. Describe what you do rather than selling it.',
    );
  }

  // ------------------------------------------------------------ attachments
  if (attachmentCount > 0) {
    add(
      'high',
      `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'} on a cold e-mail`,
      'Attachments from an unknown sender are filtered aggressively, and recipients are told not to open them.',
      'Send a link instead — that is what the Files & links section is for.',
    );
  }

  // ------------------------------------------------------------- compliance
  if (!hasUnsubscribe) {
    add('high', 'No way to opt out', 'Required by law in most places, and Gmail weighs the List-Unsubscribe header when deciding placement.', 'Turn the compliance footer back on in Settings.');
  }
  if (!hasPostalAddress) {
    add('medium', 'No postal address', 'CAN-SPAM and its equivalents require a physical address on commercial mail.', 'Add one in Settings.');
  }

  // ---------------------------------------------------------------- sender
  if (/@(gmail|yahoo|hotmail|outlook|aol|icloud)\.[a-z.]+$/i.test(fromEmail)) {
    add(
      'high',
      'Sending from a free mailbox',
      `${fromEmail.split('@')[1]} cannot be domain-authenticated as yours, and bulk cold outreach from free mailboxes is filtered hard. This is usually the single biggest reason cold e-mail lands in spam.`,
      'Send from your own domain (Google Workspace is about $7/month) and set up SPF, DKIM and DMARC — see the DNS check.',
    );
  }

  // Phrase matches stack: one "free" is noise, five trigger phrases in a row
  // is the message. Collapsing them into a single finding under-weighted that,
  // so the pile-up is added to the score on top of the finding itself.
  const stackedPhrasePenalty = Math.max(0, phraseScore - SEVERITY_WEIGHT.high);

  const score =
    findings.reduce((total, finding) => total + (SEVERITY_WEIGHT[finding.severity] || 1), 0) + stackedPhrasePenalty;

  return {
    score,
    grade: score === 0 ? 'excellent' : score <= 3 ? 'good' : score <= 7 ? 'risky' : 'poor',
    findings: findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]),
    stats: { words: words.length, links: links.length, subjectLength: trimmedSubject.length },
  };
}

/** True when a string is mostly capitals (ignoring digits and punctuation). */
function isMostlyUpperCase(value) {
  const letters = value.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.7;
}

/**
 * The advice that actually moves the needle, ordered by impact. Shown next to
 * the checks so the fix list is not purely reactive.
 */
export const DELIVERABILITY_PLAYBOOK = [
  {
    title: 'Send from your own domain, not @gmail.com',
    detail:
      'A free mailbox cannot be authenticated as yours and carries the shared reputation of everyone else on it. ' +
      'A domain with Google Workspace behind it is the single biggest improvement available.',
    impact: 'huge',
  },
  {
    title: 'Set up SPF, DKIM and DMARC',
    detail:
      'These three DNS records prove the mail really came from you. Without them, Gmail and Outlook treat bulk mail ' +
      'as unauthenticated and many providers reject it outright. The DNS check on this page tells you which are missing.',
    impact: 'huge',
  },
  {
    title: 'Warm the address up before volume',
    detail:
      'A brand-new address that sends 200 messages on day one looks exactly like a compromised account. Start at ' +
      '10–20 a day for the first two weeks and build up gradually.',
    impact: 'high',
  },
  {
    title: 'Get replies',
    detail:
      'Replies are the strongest positive reputation signal there is. A short message that asks one easy question ' +
      'beats a polished pitch that nobody answers.',
    impact: 'high',
  },
  {
    title: 'Keep it plain and short',
    detail:
      'No images, no tracking pixels, no HTML newsletter layout, one link at most. This app already sends minimal ' +
      'HTML with a plain-text alternative for exactly this reason.',
    impact: 'medium',
  },
  {
    title: 'Never buy a list, and honour every opt-out',
    detail:
      'Spam complaints and hitting a spam trap are the fastest ways to burn a domain, and reputation recovers slowly. ' +
      'One complaint per thousand sends is roughly the ceiling before providers start filtering you.',
    impact: 'high',
  },
];
