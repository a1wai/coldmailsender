/**
 * lib/places.js
 * ---------------------------------------------------------------------------
 * Business discovery and location lookup, both on fully open data.
 *
 *   - Nominatim  (OpenStreetMap geocoding)  → location autocomplete
 *   - Overpass   (OpenStreetMap query API)  → real businesses in an area
 *
 * Why this instead of scraping Google: Google's Terms of Service prohibit
 * automated access to Search and Maps results, and they actively block it with
 * CAPTCHAs — a scraper aimed at them breaks within days. OpenStreetMap data is
 * ODbL-licensed and explicitly meant to be queried, needs no API key, and for
 * many businesses it carries the website and sometimes the e-mail directly.
 *
 * Both services are free and run on donations, so this module keeps requests
 * small, caches aggressively, and identifies itself honestly. Be a good
 * citizen: their usage policies are the only thing keeping them free.
 *
 * Server-only.
 */

import axios from 'axios';
import { findBusinessType } from './business-types.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/** Overpass mirrors, tried in order — the main instance is often busy. */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'ColdMailSenderBot/1.0 (+https://github.com/a1wai/coldmailsender)';

// Business type definitions live in `lib/business-types.js` so client
// components can import them without pulling in this server-only module.

/** Escapes a value going into an Overpass tag filter or regex literal. */
function escapeOverpass(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Nominatim — location search / autocomplete
// ---------------------------------------------------------------------------

/** Small in-process cache; autocomplete fires on nearly every keystroke. */
const geocodeCache = new Map();
const GEOCODE_TTL_MS = 10 * 60 * 1000;

/**
 * Suggests places matching a partial query.
 *
 * @param {string} query
 * @param {number} [limit=6]
 * @returns {Promise<Array<{label:string, short:string, lat:number, lon:number, type:string}>>}
 */
export async function suggestLocations(query, limit = 6) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return [];

  const cacheKey = `${trimmed.toLowerCase()}:${limit}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GEOCODE_TTL_MS) return cached.value;

  try {
    const { data } = await axios.get(NOMINATIM_URL, {
      params: {
        q: trimmed,
        format: 'jsonv2',
        limit,
        addressdetails: 1,
        // Cities, towns, suburbs and regions are useful targets; individual
        // house numbers are not.
        featuretype: undefined,
      },
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      timeout: 8000,
    });

    const results = (Array.isArray(data) ? data : []).map((place) => ({
      label: place.display_name,
      short: shortLabel(place),
      lat: Number(place.lat),
      lon: Number(place.lon),
      type: place.addresstype || place.type || '',
      // Bounding box lets us size the search radius to the place itself, so
      // "Troy" searches a town-sized area and "California" does not.
      boundingbox: (place.boundingbox || []).map(Number),
    }));

    geocodeCache.set(cacheKey, { at: Date.now(), value: results });
    if (geocodeCache.size > 300) geocodeCache.delete(geocodeCache.keys().next().value);

    return results;
  } catch (error) {
    if (error?.response?.status === 429) {
      throw new Error('Location lookup is rate limited right now. Wait a moment and try again.');
    }
    throw new Error(`Location lookup failed: ${error.message}`);
  }
}

/** Builds a compact "Troy, Michigan, United States" style label. */
function shortLabel(place) {
  const address = place.address || {};
  const name =
    address.city || address.town || address.village || address.municipality ||
    address.suburb || address.county || place.name || '';
  const region = address.state || address.region || address.province || '';
  const country = address.country || '';

  return [name, region, country].filter(Boolean).join(', ') || place.display_name;
}

/**
 * Derives a sensible search radius in metres from a place's bounding box,
 * clamped so a country-sized box does not produce a 2,000 km query.
 */
export function radiusFromBoundingBox(boundingbox, fallback = 5000) {
  if (!Array.isArray(boundingbox) || boundingbox.length !== 4) return fallback;

  const [south, north, west, east] = boundingbox;
  if ([south, north, west, east].some((n) => !Number.isFinite(n))) return fallback;

  // Rough metres-per-degree at the equator; good enough for sizing a radius.
  const latSpan = Math.abs(north - south) * 111_320;
  const lonSpan = Math.abs(east - west) * 111_320 * Math.cos((((north + south) / 2) * Math.PI) / 180);

  const radius = Math.max(latSpan, lonSpan) / 2;
  return Math.round(Math.min(Math.max(radius, 1000), 25_000));
}

// ---------------------------------------------------------------------------
// Overpass — business discovery
// ---------------------------------------------------------------------------

/** Hard ceiling on any single Overpass radius, in metres. */
const MAX_RADIUS_M = 30_000;

/**
 * Finds businesses of a given type near a point.
 *
 * ## Why this is a cascade and not one query
 *
 * The single most common complaint about this feature is "Google Maps shows
 * forty dentists here and this found three". Both halves are true, for two
 * separate reasons, and the cascade addresses the one that is fixable:
 *
 *   1. Coverage. OpenStreetMap is volunteer-mapped. A business exists in it
 *      only because a human walked past and typed it in. Google's index comes
 *      from Street View, business owners claiming listings, and paid data
 *      partners. In a well-mapped European city the gap is small; in most of
 *      the US and Asia it is enormous. No amount of query tuning closes it —
 *      that is what the optional Google Places adapter is for.
 *
 *   2. Tagging. This one *was* our bug. `office=advertising_agency` is the
 *      "correct" tag for a marketing agency, and almost nobody uses it; the
 *      same business is far more likely to be `office=company` with the word
 *      "Marketing" in its name. Asking only for the textbook tag threw away
 *      most of what OSM actually holds.
 *
 * So each stage relaxes one constraint and the results are unioned:
 *
 *   1. exact tags, requested radius
 *   2. exact tags, double radius        (thin rural / suburban areas)
 *   3. container keys + name match      (`office=*` whose name says "marketing")
 *   4. name match across every business key, ignoring tags entirely
 *
 * Stages stop as soon as there are enough results, or when the deadline is
 * reached — Overpass is donation-funded and every stage costs it real CPU.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {number} [params.radius=5000]  Metres.
 * @param {string} [params.typeId]       An id from BUSINESS_TYPES.
 * @param {string} [params.keyword]      Free-text name filter.
 * @param {number} [params.limit=80]
 * @param {number} [params.deadlineMs=45000] Give up starting new stages after this.
 * @returns {Promise<{businesses: Array, diagnostics: object}>}
 */
export async function discoverBusinesses({
  lat,
  lon,
  radius = 5000,
  typeId,
  keyword,
  limit = 80,
  deadlineMs = 45_000,
}) {
  const startedAt = Date.now();
  const stages = buildSearchPlan({ lat, lon, radius, typeId, keyword, limit });

  const seen = new Map();
  const attempts = [];
  let lastError = null;

  for (const stage of stages) {
    if (seen.size >= limit) break;
    // Leave room for one full Overpass round-trip before the caller times out.
    if (attempts.length && Date.now() - startedAt > deadlineMs - 20_000) break;

    let elements = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      elements = await runOverpass(stage.query);
    } catch (error) {
      lastError = error;
      attempts.push({ ...stage.describe, error: error.message, added: 0 });
      // A rate limit will hit every subsequent stage too — stop asking.
      if (/rate limit/i.test(error.message)) break;
      continue;
    }

    let added = 0;
    for (const element of elements) {
      const business = normaliseBusiness(element);
      if (!business.business) continue;
      if (seen.has(business.osmId)) continue;
      seen.set(business.osmId, business);
      added += 1;
    }

    attempts.push({ ...stage.describe, added, returned: elements.length });
  }

  // Every stage failed and nothing came back — surface the real error rather
  // than an empty list, which reads like "there is nothing here".
  if (!seen.size && lastError) throw lastError;

  const businesses = [...seen.values()]
    // Highest-value first: an e-mail beats a website, a website beats neither.
    .sort((a, b) => scoreBusiness(b) - scoreBusiness(a))
    .slice(0, limit);

  return {
    businesses,
    diagnostics: {
      attempts,
      broadened: attempts.length > 1,
      // What the widest stage actually searched, so the UI can say so.
      radiusUsed: attempts.length ? attempts[attempts.length - 1].radius : radius,
      totalMatched: seen.size,
      durationMs: Date.now() - startedAt,
    },
  };
}

function scoreBusiness(business) {
  if (business.email) return 2;
  if (business.website) return 1;
  return 0;
}

/**
 * Produces the ordered list of queries to try. Exported for tests: the plan is
 * the interesting logic, and it can be checked without hitting a public API.
 *
 * @returns {Array<{query: string, describe: object}>}
 */
export function buildSearchPlan({ lat, lon, radius = 5000, typeId, keyword, limit = 80 }) {
  const type = findBusinessType(typeId);
  const trimmedKeyword = String(keyword || '').trim();

  if (!type && !trimmedKeyword) {
    throw new Error('Choose a business type, or type a keyword to search by name.');
  }

  const base = clampRadius(radius);
  const wide = clampRadius(base * 2);
  const plan = [];

  const push = (mode, stageRadius, extra = {}) => {
    // Skip a widened stage that is identical to one already planned.
    if (plan.some((entry) => entry.describe.mode === mode && entry.describe.radius === stageRadius)) return;
    plan.push({
      query: buildOverpassQuery({ lat, lon, radius: stageRadius, typeId, keyword, limit, mode }),
      describe: { mode, radius: stageRadius, ...extra },
    });
  };

  if (type) {
    push('exact', base);
    if (wide > base) push('exact', wide);
    // Only worth broadening when there is something to filter names by,
    // otherwise "any office within 20 km" is noise, not leads.
    if (type.broad?.length && (type.synonyms?.length || trimmedKeyword)) {
      push('broad', wide);
    }
  }

  if (trimmedKeyword) {
    push('name', type ? wide : base);
    if (!type && wide > base) push('name', wide);
  }

  return plan;
}

function clampRadius(value) {
  return Math.round(Math.min(Math.max(Number(value) || 5000, 500), MAX_RADIUS_M));
}

/**
 * Builds the Overpass QL for one stage of the plan. Split out from the network
 * call so the query construction — the part with the injection surface and the
 * fiddly syntax — can be tested without hitting a donation-funded public API.
 *
 * @param {'exact'|'broad'|'name'} [mode='exact']
 * @returns {string} Overpass QL
 */
export function buildOverpassQuery({ lat, lon, radius = 5000, typeId, keyword, limit = 80, mode = 'exact' }) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    throw new Error('A valid location is required.');
  }

  const safeRadius = clampRadius(radius);
  const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const around = `around:${safeRadius},${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;

  const type = findBusinessType(typeId);
  const trimmedKeyword = String(keyword || '').trim();
  const clauses = [];

  if (mode === 'exact' && type) {
    // A keyword alongside a type narrows it ("dental" + Doctors) rather than
    // being ignored, which is what the previous version did.
    const nameFilter = trimmedKeyword ? `["name"~"${regexLiteral([trimmedKeyword])}",i]` : '';

    for (const [key, value] of type.filters) {
      // `*` means "any value for this key", expressed as a key-presence filter.
      const tagFilter =
        value === '*'
          ? `["${escapeOverpass(key)}"]`
          : `["${escapeOverpass(key)}"="${escapeOverpass(value)}"]`;
      clauses.push(`nwr${tagFilter}${nameFilter}(${around});`);
    }
  }

  if (mode === 'broad' && type?.broad?.length) {
    // Prefer the user's own word when they gave one — it is a better signal
    // than our generic synonym list.
    const words = trimmedKeyword ? [trimmedKeyword, ...(type.synonyms || [])] : type.synonyms || [];
    if (words.length) {
      const pattern = regexLiteral(words);
      for (const key of type.broad) {
        clauses.push(`nwr["${escapeOverpass(key)}"]["name"~"${pattern}",i](${around});`);
      }
    }
  }

  if (mode === 'name' && trimmedKeyword) {
    const pattern = regexLiteral([trimmedKeyword]);
    for (const key of ['shop', 'office', 'craft', 'amenity', 'leisure', 'tourism', 'healthcare']) {
      clauses.push(`nwr["${key}"]["name"~"${pattern}",i](${around});`);
    }
  }

  if (!clauses.length) {
    throw new Error('Choose a business type, or type a keyword to search by name.');
  }

  // 20s rather than 25s: the route runs up to four of these and still has to
  // answer inside the serverless execution limit.
  return `[out:json][timeout:20];\n(\n  ${clauses.join('\n  ')}\n);\nout center ${safeLimit};`;
}

/**
 * Turns a word list into an Overpass-safe case-insensitive alternation.
 *
 * Escaping order matters. Each word is regex-escaped first, then the whole
 * alternation is escaped for the surrounding QL string literal, so a `\.` in
 * the regex is written as `\\.` in the query and Overpass unescapes it back to
 * `\.` before compiling the pattern. `|` is deliberately left alone — it is
 * the alternation operator, not user input.
 */
function regexLiteral(words) {
  const alternation = words
    .map((word) => String(word).trim())
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  return escapeOverpass(alternation);
}

/** Posts a query, falling back to the mirror when the primary is overloaded. */
async function runOverpass(query) {
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const { data } = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        // Slightly above the `[timeout:20]` in the query itself, so Overpass
        // gets the chance to return its own error rather than us aborting.
        timeout: 22_000,
      });

      if (data?.elements) return data.elements;
      lastError = new Error('Overpass returned no elements.');
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      // 429 (too many requests) and 504 (overloaded) are exactly what the
      // mirror exists for — keep going. Anything else is likely our fault.
      if (status && status !== 429 && status !== 504 && status !== 503) break;
    }
  }

  const status = lastError?.response?.status;
  if (status === 429) throw new Error('OpenStreetMap is rate limiting us. Wait about a minute and try again.');
  if (status === 400) throw new Error('That search could not be understood by OpenStreetMap. Try a different business type.');
  throw new Error(`OpenStreetMap search failed: ${lastError?.message || 'unknown error'}`);
}

/** Flattens an Overpass element into the app's lead shape. Exported for tests. */
export function normaliseBusiness(element) {
  const tags = element.tags || {};

  const website = firstTag(tags, ['website', 'contact:website', 'url', 'contact:url']);
  const email = firstTag(tags, ['email', 'contact:email']);
  const phone = firstTag(tags, ['phone', 'contact:phone', 'contact:mobile']);

  const address = [
    [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '),
    tags['addr:postcode'],
    tags['addr:city'],
  ]
    .filter(Boolean)
    .join(', ');

  return {
    osmId: `${element.type}/${element.id}`,
    business: tags.name || '',
    website: normaliseWebsite(website),
    email: (email || '').split(';')[0].trim().toLowerCase(),
    phone: (phone || '').split(';')[0].trim(),
    address,
    lat: element.lat ?? element.center?.lat ?? null,
    lon: element.lon ?? element.center?.lon ?? null,
  };
}

function firstTag(tags, keys) {
  for (const key of keys) {
    if (tags[key]) return tags[key];
  }
  return '';
}

/** OSM website values are inconsistent — normalise to an absolute https URL. */
function normaliseWebsite(value) {
  const raw = String(value || '').split(';')[0].trim();
  if (!raw) return '';

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withProtocol);
    if (!url.hostname.includes('.')) return '';
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return '';
  }
}
