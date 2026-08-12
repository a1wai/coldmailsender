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
import { BUSINESS_TYPES } from './business-types.js';

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

/**
 * Finds businesses of a given type near a point.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {number} [params.radius=5000]  Metres.
 * @param {string} [params.typeId]       An id from BUSINESS_TYPES.
 * @param {string} [params.keyword]      Free-text name filter, used when no
 *                                       type matches what the user typed.
 * @param {number} [params.limit=80]
 * @returns {Promise<Array>} Businesses with name/website/email/phone/address.
 */
export async function discoverBusinesses({ lat, lon, radius = 5000, typeId, keyword, limit = 80 }) {
  const query = buildOverpassQuery({ lat, lon, radius, typeId, keyword, limit });
  const elements = await runOverpass(query);

  return elements
    .map((element) => normaliseBusiness(element))
    .filter((business) => business.business)
    // Highest-value first: an e-mail beats a website, a website beats neither.
    .sort((a, b) => scoreBusiness(b) - scoreBusiness(a));
}

function scoreBusiness(business) {
  if (business.email) return 2;
  if (business.website) return 1;
  return 0;
}

/**
 * Builds the Overpass QL for a search. Split out from the network call so the
 * query construction — the part with the injection surface and the fiddly
 * syntax — can be tested without hitting a donation-funded public API.
 *
 * @returns {string} Overpass QL
 */
export function buildOverpassQuery({ lat, lon, radius = 5000, typeId, keyword, limit = 80 }) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    throw new Error('A valid location is required.');
  }

  const safeRadius = Math.round(Math.min(Math.max(Number(radius) || 5000, 500), 30_000));
  const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const around = `around:${safeRadius},${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;

  const type = BUSINESS_TYPES.find((entry) => entry.id === typeId);
  const clauses = [];

  if (type) {
    for (const [key, value] of type.filters) {
      // `*` means "any value for this key", expressed as a key-presence filter.
      const tagFilter =
        value === '*'
          ? `["${escapeOverpass(key)}"]`
          : `["${escapeOverpass(key)}"="${escapeOverpass(value)}"]`;
      clauses.push(`nwr${tagFilter}(${around});`);
    }
  }

  // Free-text fallback: match the name across the keys that hold businesses.
  const trimmedKeyword = String(keyword || '').trim();
  if (!type && trimmedKeyword) {
    const pattern = escapeOverpass(trimmedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const key of ['shop', 'office', 'craft', 'amenity', 'leisure', 'tourism']) {
      clauses.push(`nwr["${key}"]["name"~"${pattern}",i](${around});`);
    }
  }

  if (!clauses.length) {
    throw new Error('Choose a business type, or type a keyword to search by name.');
  }

  return `[out:json][timeout:25];\n(\n  ${clauses.join('\n  ')}\n);\nout center ${safeLimit};`;
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
        timeout: 30_000,
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
