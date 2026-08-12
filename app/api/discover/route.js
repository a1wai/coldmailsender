/**
 * POST /api/discover
 * ---------------------------------------------------------------------------
 * Finds real businesses of a given type near a location, from OpenStreetMap.
 *
 * This is step one of lead generation: it turns "real estate agents in Troy"
 * into an actual list of businesses with names, websites and — for a useful
 * minority — e-mail addresses already published in the map data. Whatever has
 * a website but no address is then handed to `/api/scrape` by the client.
 *
 * Request:
 *   {
 *     lat: number, lon: number,        // required, from /api/places
 *     radius?: number,                 // metres, default 5000, max 30000
 *     typeId?: string,                 // an id from BUSINESS_TYPES
 *     keyword?: string,                // free-text name match when no typeId
 *     limit?: number,                  // default 80, max 200
 *     industry?: string, location?: string   // copied onto leads for templating
 *   }
 *
 * Response:
 *   { ok: true, leads: Lead[], stats: { found, withEmail, withWebsite, needsCrawl } }
 */

import { discoverBusinesses } from '@/lib/places';
import { createLead } from '@/lib/leads';
import { jsonOk, jsonError, readJsonBody, rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

  const { lat, lon, radius, typeId, keyword, limit: maxResults, industry = '', location = '' } = body;

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return jsonError('Pick a location from the suggestions first.', 400);
  }

  try {
    const businesses = await discoverBusinesses({
      lat: Number(lat),
      lon: Number(lon),
      radius: Number(radius) || 5000,
      typeId,
      keyword,
      limit: Number(maxResults) || 80,
    });

    const leads = businesses.map((business) =>
      createLead({
        business: business.business,
        website: business.website,
        email: business.email,
        phone: business.phone,
        address: business.address,
        industry,
        location,
        source: 'openstreetmap',
        // No website and no e-mail means there is nothing to crawl and nothing
        // to send to — flagged so the UI can offer to filter them out.
        status: business.email ? 'new' : business.website ? 'needs-crawl' : 'no-email',
      }),
    );

    const withEmail = leads.filter((lead) => lead.email).length;
    const needsCrawl = leads.filter((lead) => !lead.email && lead.website).length;

    return jsonOk({
      leads,
      stats: {
        found: leads.length,
        withEmail,
        withWebsite: leads.filter((lead) => lead.website).length,
        needsCrawl,
      },
    });
  } catch (error) {
    console.error('[api/discover] Failed:', error.message);
    return jsonError(error.message || 'Business search failed.', 502);
  }
}
