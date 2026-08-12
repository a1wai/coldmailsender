/**
 * lib/adapters/google-places.js
 * ---------------------------------------------------------------------------
 * Optional adapter for the Google Places API (New).
 *
 * ## Why this exists
 *
 * OpenStreetMap is free and open, but it is volunteer-mapped: a business is in
 * it only because somebody walked past and typed it in. Google's index comes
 * from Street View, owners claiming their own listings, and paid data
 * partners. So "Google Maps shows forty of these and the app found three" is
 * usually not a bug — it is the coverage gap, and no query tuning closes it.
 *
 * The Places API is Google's own sanctioned route to that same index. It is
 * *not* scraping: scraping Maps or Search results breaks Google's Terms of
 * Service and gets blocked within days, which is why this app has never done
 * it. Querying the documented API with your own key is explicitly allowed, and
 * the response includes the website URL — which is all the crawler needs.
 *
 * ## Cost
 *
 * Text Search is billed per request. Google includes a recurring monthly
 * credit that covers a meaningful amount of usage for free, but past it this
 * costs money. Like ANTHROPIC_API_KEY, treat it as a paid opt-in — leave the
 * key unset and everything falls back to OpenStreetMap, which stays free
 * forever.
 *
 * Set GOOGLE_PLACES_API_KEY to enable. Restrict the key to the Places API in
 * the Google Cloud console, and set a billing budget alert.
 *
 * Server-only.
 */

import axios from 'axios';

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Only the fields we actually use. The field mask is mandatory and it drives
 * the billing tier — asking for fewer fields is both cheaper and faster, so
 * this list is deliberately minimal.
 */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.location',
  'nextPageToken',
].join(',');

/** Google caps a single page at 20 results; three pages is the documented max. */
const PAGE_SIZE = 20;
const MAX_PAGES = 3;

export function isGooglePlacesEnabled() {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY);
}

/**
 * Text search near a point, paging until `limit` is reached.
 *
 * @param {object} params
 * @param {string} params.query   e.g. "dentist" — the profession, not the place.
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {number} [params.radius=5000]  Metres. Google caps the bias at 50 km.
 * @param {number} [params.limit=60]
 * @param {string} [params.languageCode='en']
 * @returns {Promise<{businesses: Array, pagesFetched: number}>}
 */
export async function searchGooglePlaces({
  query,
  lat,
  lon,
  radius = 5000,
  limit = 60,
  languageCode = 'en',
}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set.');

  const textQuery = String(query || '').trim();
  if (!textQuery) throw new Error('A search term is required for Google Places.');

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    throw new Error('A valid location is required.');
  }

  const body = {
    textQuery,
    pageSize: PAGE_SIZE,
    languageCode,
    locationBias: {
      circle: {
        center: { latitude: Number(lat), longitude: Number(lon) },
        // Bias, not restriction: a hard restriction silently drops businesses
        // just over the line, which is rarely what someone prospecting wants.
        radius: Math.min(Math.max(Number(radius) || 5000, 500), 50_000),
      },
    },
  };

  const businesses = [];
  let pageToken = null;
  let pagesFetched = 0;

  for (let page = 0; page < MAX_PAGES && businesses.length < limit; page += 1) {
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      ({ data } = await axios.post(
        SEARCH_TEXT_URL,
        pageToken ? { ...body, pageToken } : body,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': FIELD_MASK,
          },
          timeout: 15_000,
        },
      ));
    } catch (error) {
      // A first-page failure is fatal; a later one just means fewer results.
      if (page === 0) throw new Error(describeGoogleError(error));
      break;
    }

    pagesFetched += 1;

    for (const place of data?.places || []) {
      businesses.push(normalisePlace(place));
    }

    pageToken = data?.nextPageToken || null;
    if (!pageToken) break;
  }

  return { businesses: businesses.slice(0, limit), pagesFetched };
}

/** Flattens a Places result into the app's lead shape. Exported for tests. */
export function normalisePlace(place) {
  return {
    osmId: place?.id ? `google/${place.id}` : '',
    business: place?.displayName?.text || '',
    website: normaliseWebsite(place?.websiteUri),
    // Places never returns an e-mail address — that is what the crawler is for.
    email: '',
    phone: (place?.nationalPhoneNumber || '').trim(),
    address: (place?.formattedAddress || '').trim(),
    lat: place?.location?.latitude ?? null,
    lon: place?.location?.longitude ?? null,
  };
}

function normaliseWebsite(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname.includes('.')) return '';
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return '';
  }
}

/** Google's errors are structured and worth passing through in full. */
function describeGoogleError(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.error?.message || '';

  if (status === 400 && /field mask/i.test(detail)) {
    return `Google rejected the field mask: ${detail}`;
  }
  if (status === 401 || status === 403) {
    return (
      `Google rejected the API key (${status}). ${detail} ` +
      'Check that the Places API (New) is enabled for the project, that billing is on, ' +
      'and that any key restrictions allow server-side requests.'
    );
  }
  if (status === 429) {
    return 'Google Places is rate limiting this key. Wait a moment, or raise the quota in the Cloud console.';
  }

  return detail || error?.message || 'Google Places request failed.';
}
