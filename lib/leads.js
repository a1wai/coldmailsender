/**
 * lib/leads.js
 * ---------------------------------------------------------------------------
 * The shared lead shape and the helpers that build it.
 *
 * Isomorphic — used by the discovery/scrape routes on the server and by the
 * manual "add lead" form in the browser, so both produce identical records.
 */

/** Common second-level domains, so `acme.co.uk` yields "Acme", not "Co". */
const COMPOUND_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.za', 'co.jp', 'co.kr', 'co.in', 'com.br', 'com.mx',
  'com.sg', 'com.tr', 'com.cn', 'com.tw', 'com.hk',
]);

/** Words in a domain that are not part of the business name. */
const NOISE_SEGMENTS = new Set(['www', 'the', 'my', 'get', 'try', 'go', 'app', 'web', 'site', 'online', 'hq']);

/**
 * Derives a readable business name from a website or e-mail domain.
 *
 *   https://www.intoworld.com/about  →  "Intoworld"
 *   thegreen-studio.co.uk            →  "Green Studio"
 *   hello@acme-dental.nl             →  "Acme Dental"
 *
 * Domains are the one identifier every lead has, so this gives every row a
 * usable name even when the site publishes no person and no company name.
 */
export function nameFromWebsite(websiteOrEmail) {
  const raw = String(websiteOrEmail || '').trim();
  if (!raw) return '';

  let hostname = raw;

  if (raw.includes('@')) {
    hostname = raw.split('@').pop();
  } else {
    try {
      hostname = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    } catch {
      hostname = raw.replace(/^https?:\/\//i, '').split('/')[0];
    }
  }

  hostname = hostname.replace(/^www\./i, '').toLowerCase();
  if (!hostname.includes('.')) return '';

  // Strip the public suffix, handling two-part ones like `.co.uk`.
  const parts = hostname.split('.');
  const lastTwo = parts.slice(-2).join('.');
  const label = COMPOUND_TLDS.has(lastTwo) ? parts.slice(0, -2).pop() : parts.slice(0, -1).pop();

  if (!label) return '';

  // Split on separators, and also on camelCase used in place of a separator.
  const words = label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_.]+/)
    .flatMap((word) => word.split(/\s+/))
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word, index, all) => !(all.length > 1 && NOISE_SEGMENTS.has(word)));

  if (!words.length) return '';

  return words
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Builds a complete lead record from partial data.
 *
 * `name` falls back to the domain-derived name, which is what makes the Name
 * column useful rather than mostly empty.
 */
export function createLead(partial = {}) {
  const email = String(partial.email || '').trim().toLowerCase();
  const website = String(partial.website || '').trim();
  const business = String(partial.business || '').trim();
  const derived = nameFromWebsite(website || email);

  return {
    id: partial.id || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(partial.name || '').trim() || derived,
    business: business || derived,
    website,
    email,
    phone: String(partial.phone || '').trim(),
    address: String(partial.address || '').trim(),
    status: partial.status || (email ? 'new' : 'no-email'),
    industry: partial.industry || '',
    location: partial.location || '',
    source: partial.source || 'manual',
    alternateEmails: partial.alternateEmails || [],
    error: partial.error || null,
    customFields: partial.customFields || {},
  };
}

/**
 * Merges freshly-found leads into an existing list.
 *
 * Matching is by e-mail first, then by website host — a business discovered on
 * the map and later crawled for an address must end up as one row, not two.
 * Existing values win, so a manual correction is never overwritten by a later
 * automated pass.
 */
export function mergeLeads(existing, incoming) {
  const byEmail = new Map();
  const byHost = new Map();

  const hostOf = (lead) => {
    if (!lead.website) return '';
    try {
      return new URL(lead.website).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return lead.website.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    }
  };

  const merged = [...existing];

  merged.forEach((lead, index) => {
    if (lead.email) byEmail.set(lead.email, index);
    const host = hostOf(lead);
    if (host) byHost.set(host, index);
  });

  let added = 0;
  let updated = 0;

  for (const lead of incoming) {
    const host = hostOf(lead);

    // Written out rather than chained with `??`: for a lead with no address,
    // `lead.email && byEmail.get(...)` evaluates to `''`, which `??` treats as
    // a hit (it only falls through on null/undefined) — so the host lookup was
    // skipped and `''` was used as an index into `merged`.
    const emailIndex = lead.email ? byEmail.get(lead.email) : undefined;
    const hostIndex = host ? byHost.get(host) : undefined;
    const index = emailIndex ?? hostIndex;

    if (index === undefined) {
      merged.push(lead);
      if (lead.email) byEmail.set(lead.email, merged.length - 1);
      if (host) byHost.set(host, merged.length - 1);
      added += 1;
      continue;
    }

    const current = merged[index];
    const next = {
      ...current,
      // Only fill gaps — never clobber something already there.
      name: current.name || lead.name,
      business: current.business || lead.business,
      website: current.website || lead.website,
      email: current.email || lead.email,
      phone: current.phone || lead.phone,
      address: current.address || lead.address,
      alternateEmails: current.alternateEmails?.length ? current.alternateEmails : lead.alternateEmails,
    };

    if (!current.email && next.email && current.status === 'no-email') next.status = 'new';
    if (JSON.stringify(next) !== JSON.stringify(current)) updated += 1;

    merged[index] = next;
  }

  return { leads: merged, added, updated };
}
