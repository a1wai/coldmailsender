/**
 * lib/search-urls.js
 * ---------------------------------------------------------------------------
 * Builds directory/search URLs from the lead-finder form.
 *
 * Kept separate from `lib/scraper.js` on purpose: the scraper imports
 * `node:dns` and `node:net`, so importing it from a client component would
 * drag Node built-ins into the browser bundle and break the build. This module
 * is pure string manipulation and safe on both sides.
 *
 * These are links the user opens and reviews by hand. The app deliberately
 * does NOT auto-scrape Google or Google Maps results — doing so violates their
 * Terms of Service. See the Responsible Use section of the README.
 */

export function buildSearchUrls({ industry = '', location = '', keywords = '' }) {
  const query = [industry, location, keywords]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');

  if (!query) return [];

  const encoded = encodeURIComponent(query);

  return [
    {
      label: 'Google',
      url: `https://www.google.com/search?q=${encoded}`,
      note: 'Broadest coverage. Copy the result URLs you want into the list below.',
    },
    {
      label: 'Google Maps',
      url: `https://www.google.com/maps/search/${encoded}`,
      note: 'Local businesses with a website field — the highest-yield source.',
    },
    {
      label: 'Bing',
      url: `https://www.bing.com/search?q=${encoded}`,
      note: 'Surfaces different small businesses than Google does.',
    },
    {
      label: 'DuckDuckGo',
      url: `https://duckduckgo.com/?q=${encoded}`,
      note: 'No personalisation, so results are a neutral baseline.',
    },
    {
      label: 'OpenStreetMap',
      url: `https://www.openstreetmap.org/search?query=${encoded}`,
      note: 'Fully open data — no ToS restrictions on reusing the results.',
    },
  ];
}

/**
 * Normalises whatever the user pastes into the URL box: one per line, comma
 * separated, or a wall of text with URLs mixed in. Deduplicates by origin so
 * three deep links into the same site scrape it only once.
 */
export function parseUrlList(input) {
  const raw = String(input || '');

  // Pull explicit URLs first, then fall back to bare domains on their own line.
  const explicit = raw.match(/https?:\/\/[^\s,;"'<>)\]]+/gi) || [];
  const withoutExplicit = explicit.reduce((text, url) => text.replace(url, ' '), raw);
  const bare =
    withoutExplicit.match(/(?:^|\s)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?=\s|$|[,;])/gim) || [];

  const candidates = [...explicit, ...bare.map((match) => match.trim())]
    .map((value) => value.trim().replace(/[.,;]+$/, ''))
    .filter(Boolean);

  const seen = new Set();
  const urls = [];
  const invalid = [];

  for (const candidate of candidates) {
    const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

    let parsed;
    try {
      parsed = new URL(withProtocol);
    } catch {
      invalid.push(candidate);
      continue;
    }

    // A hostname with no dot is not a public site (and is often a typo).
    if (!parsed.hostname.includes('.')) {
      invalid.push(candidate);
      continue;
    }

    const key = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    urls.push(parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname));
  }

  return { urls, invalid, duplicates: candidates.length - urls.length - invalid.length };
}

/** Splits a list into fixed-size chunks so each API call stays well under the timeout. */
export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
