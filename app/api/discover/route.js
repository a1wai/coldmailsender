/**
 * POST /api/discover
 * ---------------------------------------------------------------------------
 * Finds real businesses of a given type near a location.
 *
 * This is step one of lead generation: it turns "real estate agents in Troy"
 * into an actual list of businesses with names, websites and — for a useful
 * minority — e-mail addresses already published in the source data. Whatever
 * has a website but no address is then handed to `/api/scrape` by the client.
 *
 * Two sources, in order of preference:
 *
 *   Google Places API   Only when GOOGLE_PLACES_API_KEY is set. Same index as
 *                       Google Maps, so it finds what the user sees when they
 *                       search Maps by hand. Paid past the monthly credit.
 *   OpenStreetMap       Always available, free forever, no key. Coverage is
 *                       thinner and varies enormously by region.
 *
 * When Google is configured, both are queried and the results merged by
 * website host — Google brings the breadth, OSM occasionally brings an e-mail
 * address Google never exposes.
 *
 * Request:
 *   {
 *     lat: number, lon: number,        // required, from /api/places
 *     radius?: number,                 // metres, default 5000, max 30000
 *     typeId?: string,                 // an id from BUSINESS_TYPES
 *     keyword?: string,                // free-text name match
 *     limit?: number,                  // default 80, max 200
 *     source?: 'auto'|'osm'|'google',  // default 'auto'
 *     industry?: string, location?: string   // copied onto leads for templating
 *   }
 *
 * Response:
 *   { ok: true, leads: Lead[], stats: {...}, diagnostics: {...} }
 */

import { discoverBusinesses } from '@/lib/places';
import { findBusinessType } from '@/lib/business-types';
import { searchGooglePlaces, isGooglePlacesEnabled } from '@/lib/adapters/google-places';
import { createLead } from '@/lib/leads';
import { jsonOk, jsonError, readJsonBody, rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The OSM path runs up to four Overpass queries in sequence; 30s was not
// enough for the widened stages in a dense area.
export const maxDuration = 60;

export async function POST(request) {
  // Overpass is donation-funded and a heavy query costs it real CPU.
  const limit = rateLimit(`discover:${clientKey(request)}`, { limit: 12, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonError(
      `Too many searches. Wait ${limit.retryAfter}s — OpenStreetMap is a free service, so this app throttles itself.`,
      429,
      { retryAfter: limit.retryAfter },
    );
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch (error) {
    return jsonError(error.message, error.status || 400);
  }

  const {
    lat,
    lon,
    radius,
    typeId,
    keyword,
    limit: maxResults,
    source = 'auto',
    industry = '',
    location = '',
  } = body;

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return jsonError('Pick a location from the suggestions first.', 400);
  }

  const wanted = Math.min(Math.max(Number(maxResults) || 80, 1), 200);
  const googleAvailable = isGooglePlacesEnabled();
  const useGoogle = googleAvailable && source !== 'osm';
  const useOsm = source !== 'google';

  if (source === 'google' && !googleAvailable) {
    return jsonError('Google Places is not configured. Set GOOGLE_PLACES_API_KEY, or switch the source to OpenStreetMap.', 400);
  }

  const startedAt = Date.now();
  const diagnostics = { google: null, osm: null, sources: [] };
  const merged = new Map();
  const errors = [];

  // ---------------------------------------------------------------- Google
  if (useGoogle) {
    try {
      const type = findBusinessType(typeId);
      const query = [type?.query, String(keyword || '').trim()].filter(Boolean).join(' ') || 'businesses';

      const google = await searchGooglePlaces({
        query,
        lat: Number(lat),
        lon: Number(lon),
        radius: Number(radius) || 5000,
        limit: wanted,
      });

      for (const business of google.businesses) absorb(merged, business, 'google');

      diagnostics.google = { query, found: google.businesses.length, pagesFetched: google.pagesFetched };
      diagnostics.sources.push('google');
    } catch (error) {
      console.error('[api/discover] Google Places failed:', error.message);
      diagnostics.google = { error: error.message };
      errors.push(`Google Places: ${error.message}`);
    }
  }

  // ------------------------------------------------------------------- OSM
  // Skipped once Google has already filled the quota — OSM would only add
  // duplicates at that point, and it is a free service worth not hammering.
  if (useOsm && merged.size < wanted) {
    try {
      const osm = await discoverBusinesses({
        lat: Number(lat),
        lon: Number(lon),
        radius: Number(radius) || 5000,
        typeId,
        keyword,
        limit: wanted,
        deadlineMs: Math.max(15_000, 45_000 - (Date.now() - startedAt)),
      });

      for (const business of osm.businesses) absorb(merged, business, 'openstreetmap');

      diagnostics.osm = { ...osm.diagnostics, found: osm.businesses.length };
      diagnostics.sources.push('openstreetmap');
    } catch (error) {
      console.error('[api/discover] OpenStreetMap failed:', error.message);
      diagnostics.osm = { error: error.message };
      errors.push(`OpenStreetMap: ${error.message}`);
    }
  }

  // Both sources down (or the only enabled one) — that is a real failure.
  if (!merged.size && errors.length) {
    return jsonError(errors.join(' · '), 502, { diagnostics });
  }

  const leads = [...merged.values()]
    // An e-mail beats a website, a website beats neither.
    .sort((a, b) => scoreBusiness(b) - scoreBusiness(a))
    .slice(0, wanted)
    .map((business) =>
      createLead({
        business: business.business,
        website: business.website,
        email: business.email,
        phone: business.phone,
        address: business.address,
        industry,
        location,
        source: business.source,
        // No website and no e-mail means there is nothing to crawl and nothing
        // to send to — flagged so the UI can offer to filter them out.
        status: business.email ? 'new' : business.website ? 'needs-crawl' : 'no-email',
      }),
    );

  const withEmail = leads.filter((lead) => lead.email).length;
  const withWebsite = leads.filter((lead) => lead.website).length;

  return jsonOk({
    leads,
    stats: {
      found: leads.length,
      withEmail,
      withWebsite,
      needsCrawl: leads.filter((lead) => !lead.email && lead.website).length,
      // The dead end worth naming: a business nobody can be contacted at.
      noContactRoute: leads.length - withWebsite,
      googleAvailable,
      durationMs: Date.now() - startedAt,
    },
    diagnostics,
    // Non-fatal: one source failed but the other answered.
    warnings: errors,
  });
}

/**
 * Adds a business to the merge map, keyed by website host where there is one.
 *
 * Google and OSM describe the same business differently — different names,
 * different ids — so the website is the only reliable join key. Where they
 * overlap, keep whichever fields each source actually filled in: OSM
 * contributes e-mail addresses roughly a tenth of the time, and Google never
 * does.
 */
function absorb(map, business, source) {
  if (!business.business) return;

  const key = hostOf(business.website) || `${source}:${business.osmId || business.business.toLowerCase()}`;
  const existing = map.get(key);

  if (!existing) {
    map.set(key, { ...business, source });
    return;
  }

  map.set(key, {
    ...existing,
    email: existing.email || business.email,
    phone: existing.phone || business.phone,
    address: existing.address || business.address,
    website: existing.website || business.website,
    source: existing.source === source ? source : `${existing.source}+${source}`,
  });
}

function hostOf(website) {
  if (!website) return '';
  try {
    return new URL(website).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function scoreBusiness(business) {
  if (business.email) return 2;
  if (business.website) return 1;
  return 0;
}
