/**
 * lib/scraper.js
 * ---------------------------------------------------------------------------
 * Lightweight, dependency-minimal lead scraper built on `axios` + `cheerio`.
 *
 * What it does:
 *   1. Fetches a public web page (with SSRF protection and robots.txt respect).
 *   2. Pulls e-mail addresses out of `mailto:` links and visible text.
 *   3. Follows a small number of obvious "contact"/"about" links, because that
 *      is where businesses actually publish their address.
 *   4. Guesses the business name and (where available) a contact person.
 *
 * Design notes:
 *   - Server-only. Requires the Node.js runtime (uses `node:dns`, `node:net`).
 *   - Deliberately conservative: short timeouts, hard page cap, response size
 *     cap, and no JavaScript execution. For JS-rendered sites, use the
 *     Firecrawl adapter in `lib/adapters/firecrawl.js`.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import axios from 'axios';
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Configuration (env-overridable — see .env.example)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  timeoutMs: Number(process.env.SCRAPER_TIMEOUT_MS) || 12_000,
  maxPages: Number(process.env.SCRAPER_MAX_PAGES) || 6,
  respectRobots: process.env.SCRAPER_RESPECT_ROBOTS !== 'false',
  userAgent:
    process.env.SCRAPER_USER_AGENT ||
    'ColdMailSenderBot/1.0 (+https://github.com/a1wai/coldmailsender)',
  // 3 MB is generous for HTML; anything larger is almost certainly not a
  // contact page and would only waste serverless execution time.
  maxContentLength: 3 * 1024 * 1024,
};

/**
 * Matches the overwhelming majority of real-world addresses without trying to
 * be RFC 5322 complete (that regex is famously unusable in practice).
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;

/** Obfuscations businesses use to dodge naive scrapers, e.g. "hi [at] acme.com". */
const OBFUSCATION_PATTERNS = [
  { re: /\s*\[\s*at\s*\]\s*/gi, to: '@' },
  { re: /\s*\(\s*at\s*\)\s*/gi, to: '@' },
  { re: /\s+at\s+(?=[a-z0-9-]+\s*(?:\[|\()?\s*dot)/gi, to: '@' },
  { re: /\s*\[\s*dot\s*\]\s*/gi, to: '.' },
  { re: /\s*\(\s*dot\s*\)\s*/gi, to: '.' },
  { re: /\s+dot\s+/gi, to: '.' },
];

/** Addresses that are never worth outreach. */
const BLOCKED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'nulled',
  'postmaster', 'mailer-daemon', 'abuse', 'webmaster@example',
]);

/** Domains that show up in boilerplate, analytics snippets and stock templates. */
const BLOCKED_DOMAIN_FRAGMENTS = [
  'example.com', 'example.org', 'domain.com', 'yourdomain', 'email.com',
  'sentry.io', 'sentry-next.wixpress', 'wixpress.com', 'wix.com',
  'squarespace.com', 'godaddy.com', 'shopify.com', 'cloudflare.com',
  'googleapis.com', 'gstatic.com', 'w3.org', 'schema.org', 'jquery.com',
  'fontawesome.com', 'bootstrapcdn.com', 'placeholder.com', 'test.com',
  'sentry.wixpress.com', 'lorem.com',
];

/** File extensions that regex-match as a TLD (e.g. `logo@2x.png`). */
const FILE_EXTENSION_TAIL =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|json|xml|pdf|mp4|webm|woff2?|ttf|eot)$/i;

/**
 * Link text / hrefs that lead to contact details, best signal first — the
 * index doubles as the score in `findContactLinks`.
 *
 * Deliberately multilingual: a Dutch site says "contactgegevens", a German one
 * is legally required to publish an "Impressum", and the English-only list
 * missed both. `team` and `over-ons` style pages matter because that is where
 * a *named person* lives, which beats a generic info@ inbox.
 */
const CONTACT_HINTS = [
  // Direct contact pages
  'contact-us', 'contactus', 'contact', 'kontakt', 'contacto', 'contatti',
  'contactgegevens', 'kontakta', 'yhteystiedot', 'contato', 'iletisim',
  'get-in-touch', 'getintouch', 'reach-us', 'reach-out', 'connect',
  'enquiry', 'enquiries', 'inquiries', 'write-to-us',
  // Legally-mandated imprints — always carry an address in the EU
  'impressum', 'imprint', 'legal-notice', 'mentions-legales', 'colofon',
  // People pages: the best source of a named human
  'our-team', 'the-team', 'team', 'meet-the-team', 'people', 'staff',
  'leadership', 'management', 'founders', 'who-we-are', 'over-ons',
  'about-us', 'aboutus', 'about', 'a-propos', 'ueber-uns', 'uber-uns',
  // Weaker, but often the only thing present
  'support', 'help', 'customer-service', 'book', 'booking', 'quote',
];

/** Role addresses ranked by how likely a human actually reads them. */
const LOCAL_PART_SCORES = [
  [/^(hello|hi|hey)$/i, 100],
  [/^(contact|kontakt|contacto)$/i, 95],
  [/^(info|enquiries|enquiry|inquiries)$/i, 90],
  [/^(sales|partnerships|bd|business)$/i, 85],
  [/^(team|studio|office|mail|email)$/i, 70],
  [/^(support|help|helpdesk|service)$/i, 50],
  [/^(admin|webmaster|billing|accounts|finance|jobs|careers|hr|press|media|legal|privacy|dpo)$/i, 20],
];

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * True for addresses that must never be reachable from a user-supplied URL:
 * loopback, link-local, RFC1918, CGNAT, and their IPv6 equivalents. Without
 * this check, a hosted deployment happily proxies requests to internal
 * metadata endpoints (169.254.169.254) on the attacker's behalf.
 */
function isPrivateAddress(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;     // RFC1918
    if (a === 192 && b === 168) return true;              // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 192 && b === 0) return true;                // IETF protocol assignments
    if (a >= 224) return true;                            // multicast + reserved
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80')) return true;                 // link-local
    if (/^f[cd]/.test(normalized)) return true;                     // unique local
    // IPv4-mapped (::ffff:10.0.0.1) — re-check the embedded v4 address.
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  // Not an IP literal — caller resolves DNS before calling us.
  return false;
}

/**
 * Validates a user-supplied URL and confirms every DNS answer is a public
 * address. Throws a descriptive Error when the URL should not be fetched.
 */
export async function assertFetchableUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are supported (got ${url.protocol})`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`Refusing to fetch a private address: ${hostname}`);
    }
    return url;
  }

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(hostname)) {
    throw new Error(`Refusing to fetch an internal hostname: ${hostname}`);
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS lookup failed for ${hostname}`);
  }

  if (!records.length) throw new Error(`DNS returned no records for ${hostname}`);

  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(`Refusing to fetch ${hostname} — it resolves to a private address`);
    }
  }

  return url;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

const robotsCache = new Map();

/**
 * Minimal robots.txt parser: collects `Disallow`/`Allow` rules from the
 * `User-agent: *` group (plus any group naming our bot) and applies
 * longest-match-wins, which is what the de-facto standard specifies.
 *
 * Fails open — an unreachable robots.txt does not block the crawl, matching
 * the behaviour of every mainstream crawler.
 */
async function isAllowedByRobots(url, { userAgent, timeoutMs }) {
  const origin = url.origin;

  if (!robotsCache.has(origin)) {
    robotsCache.set(
      origin,
      (async () => {
        try {
          const { data } = await axios.get(`${origin}/robots.txt`, {
            timeout: Math.min(timeoutMs, 5000),
            headers: { 'User-Agent': userAgent },
            responseType: 'text',
            maxRedirects: 3,
            validateStatus: (s) => s < 500,
          });
          return typeof data === 'string' ? parseRobots(data) : [];
        } catch {
          return []; // fail open
        }
      })(),
    );
  }

  const rules = await robotsCache.get(origin);
  if (!rules.length) return true;

  const path = url.pathname + url.search;
  let decision = true;
  let matchedLength = -1;

  for (const rule of rules) {
    if (!path.startsWith(rule.path)) continue;
    // Longest matching rule wins; Allow beats Disallow at equal length.
    if (rule.path.length > matchedLength || (rule.path.length === matchedLength && rule.allow)) {
      matchedLength = rule.path.length;
      decision = rule.allow;
    }
  }

  return decision;
}

function parseRobots(text) {
  const rules = [];
  let groupApplies = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const [rawField, ...rest] = line.split(':');
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      groupApplies = agent === '*' || agent.includes('coldmailsender');
      continue;
    }

    if (!groupApplies) continue;

    if (field === 'disallow' || field === 'allow') {
      // An empty Disallow means "allow everything" — skip it entirely.
      if (field === 'disallow' && value === '') continue;
      rules.push({ path: value.replace(/\*$/, ''), allow: field === 'allow' });
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchHtml(url, opts) {
  const response = await axios.get(url.toString(), {
    timeout: opts.timeoutMs,
    maxRedirects: 4,
    maxContentLength: opts.maxContentLength,
    responseType: 'text',
    decompress: true,
    headers: {
      'User-Agent': opts.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // Treat 4xx as "no content here" rather than throwing — a missing /contact
    // page is an expected outcome, not an error worth aborting the whole site.
    validateStatus: (status) => status >= 200 && status < 500,
  });

  const contentType = String(response.headers['content-type'] || '');
  if (response.status >= 400) return null;
  if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return null;
  if (typeof response.data !== 'string') return null;

  return response.data;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Applies common anti-scraper obfuscations in reverse. */
function deobfuscate(text) {
  return OBFUSCATION_PATTERNS.reduce((acc, { re, to }) => acc.replace(re, to), text);
}

function isPlausibleEmail(email) {
  const lower = email.toLowerCase();
  const [localPart, domain] = lower.split('@');

  if (!localPart || !domain) return false;
  if (localPart.length > 64 || lower.length > 254) return false;
  if (FILE_EXTENSION_TAIL.test(lower)) return false;
  if (BLOCKED_LOCAL_PARTS.has(localPart)) return false;
  if (/^(noreply|no-reply|donotreply)/.test(localPart)) return false;
  if (BLOCKED_DOMAIN_FRAGMENTS.some((fragment) => domain.includes(fragment))) return false;
  // Hex blobs like `a3f9c2b1e4@2x` are sprite/hash artefacts, not addresses.
  if (/^[0-9a-f]{16,}$/.test(localPart)) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;

  return true;
}

/**
 * Rates one address.
 *
 * `personal` is returned as a flag rather than folded into the score, because
 * reaching a named human always beats a shared inbox and that ordering must
 * not be reversible by score adjustments elsewhere (a `mailto:` bonus on
 * `hello@` would otherwise outrank a person found in body text).
 *
 * @returns {{ score: number, personal: boolean }}
 */
function scoreEmail(email, siteHostname) {
  const [localPart, domain] = email.toLowerCase().split('@');
  let score = 60;

  const roleMatch = LOCAL_PART_SCORES.find(([pattern]) => pattern.test(localPart));
  if (roleMatch) score = roleMatch[1];

  // `firstname@` or `first.last@` that is not a known role address.
  const personal = !roleMatch && /^[a-z]+(\.[a-z]+)?$/.test(localPart);
  if (personal) score = 110;

  // Strongly prefer addresses on the site's own domain over gmail/hotmail.
  if (siteHostname) {
    const root = siteHostname.replace(/^www\./, '');
    if (domain === root || domain.endsWith(`.${root}`)) score += 25;
  }
  if (/^(gmail|yahoo|hotmail|outlook|icloud|aol|proton(mail)?)\./.test(`${domain}.`)) score -= 15;

  return { score, personal };
}

/** Personal addresses first, then by score. Shared by every ranked list here. */
function compareRankedEmails(a, b) {
  if (a.personal !== b.personal) return a.personal ? -1 : 1;
  return b.score - a.score;
}

/**
 * Extracts every plausible address from a page, preferring `mailto:` links
 * (which are unambiguous) over free text.
 */
export function extractEmails(html, siteHostname) {
  const $ = cheerio.load(html);
  const found = new Map();

  const record = (raw, boost = 0) => {
    const email = String(raw).trim().replace(/^mailto:/i, '').split('?')[0].trim();
    if (!EMAIL_REGEX.test(email)) {
      EMAIL_REGEX.lastIndex = 0;
      return;
    }
    EMAIL_REGEX.lastIndex = 0;

    const normalized = email.toLowerCase();
    if (!isPlausibleEmail(normalized)) return;

    const { score, personal } = scoreEmail(normalized, siteHostname);
    const total = score + boost;

    if (!found.has(normalized) || found.get(normalized).score < total) {
      found.set(normalized, { score: total, personal });
    }
  };

  // 1. mailto: links — the highest-confidence source.
  $('a[href^="mailto:" i]').each((_, el) => record($(el).attr('href') || '', 15));

  // 2. Visible text, with obfuscations undone. Scripts and styles are dropped
  //    first so we do not mine analytics keys and CSS selectors.
  $('script, style, noscript, svg').remove();
  const text = deobfuscate($('body').text() || '');
  for (const match of text.match(EMAIL_REGEX) || []) record(match);

  // 3. Structured data and meta tags occasionally carry a clean address.
  $('meta[content*="@"]').each((_, el) => {
    const content = $(el).attr('content') || '';
    for (const match of content.match(EMAIL_REGEX) || []) record(match, 5);
  });

  return [...found.entries()]
    .map(([email, meta]) => ({ email, ...meta }))
    .sort(compareRankedEmails);
}

/** Best-effort business name from OpenGraph → JSON-LD → <title> → <h1>. */
export function extractBusinessName(html, hostname) {
  const $ = cheerio.load(html);

  const ogSiteName = $('meta[property="og:site_name"]').attr('content');
  if (ogSiteName?.trim()) return cleanName(ogSiteName);

  const jsonLdName = readJsonLd($, ['Organization', 'LocalBusiness', 'Corporation'], 'name');
  if (jsonLdName) return cleanName(jsonLdName);

  const title = $('title').first().text();
  if (title?.trim()) {
    // Titles are usually "Page Name | Business" or "Business - Tagline".
    const segments = title.split(/[|–—·»]|\s-\s/).map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) return cleanName(segments[segments.length - 1]);
    if (segments.length === 1) return cleanName(segments[0]);
  }

  const h1 = $('h1').first().text();
  if (h1?.trim()) return cleanName(h1);

  return hostname ? cleanName(hostname.replace(/^www\./, '').split('.')[0]) : '';
}

/** Best-effort contact person from JSON-LD Person or an author meta tag. */
export function extractPersonName(html) {
  const $ = cheerio.load(html);

  const personName = readJsonLd($, ['Person'], 'name');
  if (personName) return cleanName(personName);

  const founder = readJsonLd($, ['Organization', 'LocalBusiness'], 'founder');
  if (typeof founder === 'string') return cleanName(founder);
  if (founder?.name) return cleanName(founder.name);

  const author = $('meta[name="author"]').attr('content');
  if (author?.trim() && !/^(admin|wordpress|team)$/i.test(author.trim())) return cleanName(author);

  return '';
}

function readJsonLd($, types, field) {
  let result = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (result) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const nodeTypes = [].concat(node['@type'] || []);
        if (nodeTypes.some((t) => types.includes(t)) && node[field]) {
          result = node[field];
          return;
        }
      }
    } catch {
      // Malformed JSON-LD is extremely common — ignore and move on.
    }
  });

  return result;
}

function cleanName(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/^[\s|\-–—·]+|[\s|\-–—·]+$/g, '')
    .trim()
    .slice(0, 120);
}

/** Finds same-origin links that look like contact/about pages, best first. */
export function findContactLinks(html, baseUrl, limit) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const scored = new Map();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;

    let target;
    try {
      target = new URL(href, base);
    } catch {
      return;
    }

    // Same registrable host only — we are not crawling the whole internet.
    if (target.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;

    target.hash = '';
    const key = target.toString();
    if (key === baseUrl) return;

    const haystack = `${target.pathname} ${$(el).text()}`.toLowerCase();
    const hintIndex = CONTACT_HINTS.findIndex((hint) => haystack.includes(hint));
    if (hintIndex === -1) return;

    // Earlier hints in CONTACT_HINTS are the stronger signals.
    const score = CONTACT_HINTS.length - hintIndex;
    if (!scored.has(key) || scored.get(key) < score) scored.set(key, score);
  });

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}


/**
 * Common job titles, used to tell "Sarah Jansen, Studio Manager" apart from
 * an arbitrary pair of capitalised words.
 */
/**
 * Job titles, longest-first — regex alternation is first-match-wins, so
 * "manager" listed before "studio manager" would report the wrong half.
 */
const ROLE_WORD_SOURCE =
  '(managing director|co[- ]?founder|head of [a-z ]{3,20}|contact person|' +
  '(?:studio|office|general|project|account|sales|marketing|operations|production|practice) manager|' +
  'creative director|art director|owner|founder|director|manager|ceo|cto|coo|cmo|' +
  'partner|principal|proprietor|president|editor|producer|agent|consultant|' +
  'specialist|coordinator|supervisor|administrator|receptionist|secretary|chef|lead|head)';

const ROLE_WORDS = new RegExp(`\\b${ROLE_WORD_SOURCE}\\b`, 'i');

/**
 * Everything stripped before matching a name: the titles above plus generic
 * nouns that sit next to names on a contact card. These are removed only so
 * they cannot be absorbed into the name — they are never reported as roles.
 */
const NAME_STOP_WORDS = new RegExp(
  `\\b(${ROLE_WORD_SOURCE.slice(1, -1)}|studio|office|team|department|enquiries|general|contact|email|phone|tel|mobile)\\b`,
  'gi',
);

/** Two-to-three capitalised words that look like a person's name. */
const PERSON_NAME_RE =
  /\b([A-Z][a-z'’-]{1,20}(?:\s+(?:van|van der|van den|de|der|den|di|da|le|la|el|bin|al)\b)?\s+[A-Z][a-z'’-]{1,20}(?:\s+[A-Z][a-z'’-]{1,20})?)\b/;

/** Words that look like names but never are. */
const NOT_A_NAME =
  /\b(privacy policy|terms|cookie|all rights|contact us|read more|our team|get in touch|customer service|opening hours|united states|united kingdom|new york|los angeles|main street|view map|google maps|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/i;

/**
 * Pairs each address with the person and role sitting next to it in the page.
 *
 * This is the difference between "info@studio.nl" and "Sarah Jansen, Studio
 * Manager — sarah@studio.nl". A named human in the greeting is the single
 * biggest lift available to a cold e-mail, so it is worth the extra DOM walk.
 *
 * Strategy: for every element whose text contains an address, walk up to a
 * container with enough surrounding text, then look for a name and a title
 * inside it.
 *
 * @returns {Map<string, {name: string, role: string}>} keyed by lower-case address
 */
export function extractContactContext(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const contexts = new Map();

  const consider = (email, text) => {
    const key = email.toLowerCase();
    if (contexts.has(key) && contexts.get(key).name) return;

    // Strip the address itself so its local part cannot be read as a name.
    const cleaned = String(text).replace(new RegExp(escapeRegex(email), 'gi'), ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length > 400) return;

    const roleMatch = cleaned.match(ROLE_WORDS);

    // Match the name against text with role words removed. Without this the
    // optional third capitalised word swallows the start of the job title —
    // "Sarah Jansen Studio Manager" yields the name "Sarah Jansen Studio",
    // which then lands in the greeting of the e-mail.
    const nameHaystack = cleaned.replace(NAME_STOP_WORDS, ' | ');
    const nameMatch = nameHaystack.match(PERSON_NAME_RE);
    const name = nameMatch && !NOT_A_NAME.test(nameMatch[1]) ? nameMatch[1].trim() : '';

    if (!name && !roleMatch) return;

    contexts.set(key, {
      name: name || contexts.get(key)?.name || '',
      role: roleMatch ? roleMatch[0].trim() : contexts.get(key)?.role || '',
    });
  };

  // mailto: links carry the tightest association — the surrounding block is
  // almost always that person's card.
  $('a[href^="mailto:" i]').each((_, el) => {
    const email = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (!email) return;

    let node = $(el);
    // Climb until the container has enough text to hold a name, but not so
    // far that we scoop up the entire page.
    for (let depth = 0; depth < 4; depth += 1) {
      const parent = node.parent();
      if (!parent.length) break;
      node = parent;
      const text = blockText($, node);
      if (text.length > 25) {
        consider(email, text);
        if (text.length > 120) break;
      }
    }
  });

  // Plain-text addresses: use the nearest block-level ancestor's text.
  $('p, li, td, div, section, address, article').each((_, el) => {
    const text = blockText($, el);
    if (!text || text.length > 400) return;
    for (const match of text.match(EMAIL_REGEX) || []) consider(match, text);
  });

  return contexts;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Element text with visible separators between block children.
 *
 * cheerio's `.text()` concatenates with nothing in between, so a perfectly
 * ordinary contact card — `<h3>Sarah Jansen</h3><p>Studio Manager</p>` —
 * collapses to "Sarah JansenStudio Manager" and no name regex can recover it.
 * A pipe is used rather than a space so the name matcher cannot run two
 * separate fields together into one bogus name.
 */
function blockText($, el) {
  return ($.html(el) || '')
    .replace(/<br\s*\/?>/gi, ' | ')
    .replace(/<\/(p|div|h[1-6]|li|td|tr|section|address|article|span|strong|em|a)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s*\|\s*(\|\s*)+/g, ' | ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Falls back to the sitemap when a site's navigation hides its contact page
 * behind JavaScript — common on Squarespace, Wix and Framer builds, where the
 * HTML we can see contains almost no real links.
 *
 * @returns {Promise<string[]>} Contact-ish URLs, best first.
 */
export async function findSitemapContactUrls(origin, opts, limit = 4) {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`];

  for (const sitemapUrl of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data, status } = await axios.get(sitemapUrl, {
        timeout: Math.min(opts.timeoutMs, 6000),
        headers: { 'User-Agent': opts.userAgent },
        responseType: 'text',
        maxRedirects: 3,
        maxContentLength: 2 * 1024 * 1024,
        validateStatus: (code) => code < 500,
      });

      if (status >= 400 || typeof data !== 'string') continue;

      const locs = [...data.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]);
      if (!locs.length) continue;

      const scored = locs
        .map((loc) => {
          const path = loc.toLowerCase();
          const hintIndex = CONTACT_HINTS.findIndex((hint) => path.includes(hint));
          return hintIndex === -1 ? null : { loc, score: CONTACT_HINTS.length - hintIndex };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.loc);

      if (scored.length) return scored;
    } catch {
      // No sitemap, or it is not readable — that is fine, this is a fallback.
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes one site for contact details.
 *
 * @param {string} rawUrl        Any public http(s) URL.
 * @param {object} [options]
 * @param {number} [options.maxPages]       Homepage + contact pages to visit.
 * @param {number} [options.timeoutMs]      Per-request timeout.
 * @param {boolean} [options.respectRobots] Honour robots.txt (default true).
 * @returns {Promise<{website:string,business:string,name:string,email:string,
 *                    emails:Array,pagesVisited:string[],error:string|null}>}
 */
export async function scrapeSite(rawUrl, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const normalizedInput = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  const result = {
    website: normalizedInput,
    business: '',
    name: '',
    email: '',
    emails: [],
    pagesVisited: [],
    error: null,
  };

  let startUrl;
  try {
    startUrl = await assertFetchableUrl(normalizedInput);
  } catch (error) {
    result.error = error.message;
    return result;
  }

  result.website = startUrl.origin + (startUrl.pathname === '/' ? '' : startUrl.pathname);

  const queue = [startUrl.toString()];
  const seen = new Set();
  const collected = new Map();
  const contactContext = new Map();
  // Kept for the optional AI extraction pass in /api/scrape.
  const pageTexts = [];
  let triedSitemap = false;

  while (queue.length && result.pagesVisited.length < opts.maxPages) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);

    let pageUrl;
    try {
      pageUrl = await assertFetchableUrl(current);
    } catch {
      continue; // A redirect target went somewhere private — skip it.
    }

    if (opts.respectRobots) {
      const allowed = await isAllowedByRobots(pageUrl, opts);
      if (!allowed) {
        // The site explicitly asked crawlers not to read this path.
        if (current === startUrl.toString()) {
          result.error = 'Blocked by robots.txt';
          return result;
        }
        continue;
      }
    }

    let html;
    try {
      html = await fetchHtml(pageUrl, opts);
    } catch (error) {
      if (current === startUrl.toString()) {
        result.error = describeFetchError(error);
        return result;
      }
      continue;
    }

    if (!html) continue;
    result.pagesVisited.push(current);

    for (const { email, score, personal } of extractEmails(html, pageUrl.hostname)) {
      if (!collected.has(email) || collected.get(email).score < score) {
        collected.set(email, { score, personal });
      }
    }

    // Who does each address belong to, and what is their role?
    for (const [email, context] of extractContactContext(html)) {
      const existing = contactContext.get(email);
      if (!existing || (!existing.name && context.name)) contactContext.set(email, context);
    }

    pageTexts.push({ url: current, text: visibleText(html).slice(0, 4000) });

    // Metadata is only read from the entry page — deeper pages describe
    // themselves ("Contact Us"), not the business.
    if (current === startUrl.toString()) {
      result.business = extractBusinessName(html, pageUrl.hostname);
      result.name = extractPersonName(html);

      const remaining = opts.maxPages - 1;
      const links = remaining > 0 ? findContactLinks(html, current, remaining) : [];
      queue.push(...links);

      // Nothing contact-shaped in the markup usually means the navigation is
      // rendered client-side. The sitemap is static, so it still lists the
      // pages we want.
      if (!links.length && remaining > 0) {
        triedSitemap = true;
        // eslint-disable-next-line no-await-in-loop
        const fromSitemap = await findSitemapContactUrls(pageUrl.origin, opts, remaining);
        queue.push(...fromSitemap);
      }
    } else if (!result.name) {
      result.name = extractPersonName(html);
    }

    // Found a named human — further pages will only turn up role inboxes.
    if ([...collected.values()].some((entry) => entry.personal)) break;
  }

  const ranked = [...collected.entries()]
    .map(([email, meta]) => ({ email, ...meta, ...(contactContext.get(email) || {}) }))
    .sort(compareRankedEmails);

  result.emails = ranked.map((entry) => entry.email);
  result.email = result.emails[0] || '';
  result.contacts = ranked.map(({ email, name, role }) => ({ email, name: name || '', role: role || '' }));
  result.pageTexts = pageTexts;
  result.triedSitemap = triedSitemap;

  // A name attached to the chosen address beats anything guessed from metadata.
  const chosen = ranked[0];
  if (chosen?.name) result.name = chosen.name;
  if (chosen?.role) result.role = chosen.role;

  if (!result.email && !result.error) {
    result.error = result.pagesVisited.length
      ? 'No e-mail address found on the pages checked'
      : 'Could not read any page on this site';
  }

  return result;
}

/**
 * Scrapes many sites with bounded concurrency so a batch of 50 URLs does not
 * open 50 sockets at once (and does not blow the serverless time budget).
 */
export async function scrapeSites(urls, options = {}) {
  const concurrency = Math.max(1, Math.min(options.concurrency || 4, 8));
  const queue = [...urls];
  const results = [];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      try {
        results.push(await scrapeSite(url, options));
      } catch (error) {
        results.push({
          website: url,
          business: '',
          name: '',
          email: '',
          emails: [],
          pagesVisited: [],
          error: error.message || 'Unexpected scrape failure',
        });
      }
    }
  });

  await Promise.all(workers);

  // Preserve the caller's original ordering — workers finish out of order.
  const byUrl = new Map(results.map((r) => [r.website, r]));
  return urls.map(
    (url) =>
      byUrl.get(url) ||
      results.find((r) => r.website.includes(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))) ||
      results.shift(),
  );
}

/** Page text with scripts and styling stripped — the input for the AI pass. */
export function visibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function describeFetchError(error) {
  const code = error?.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'Timed out while loading the site';
  if (code === 'ENOTFOUND') return 'Domain could not be resolved';
  if (code === 'ECONNREFUSED') return 'Connection refused by the server';
  if (code === 'CERT_HAS_EXPIRED') return 'The site has an expired TLS certificate';
  if (error?.response?.status) return `Site responded with HTTP ${error.response.status}`;
  return error?.message || 'Failed to load the site';
}

// Search-URL construction lives in `lib/search-urls.js` — it must be
// importable from client components, and this module pulls in Node built-ins.
