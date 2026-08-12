/**
 * GET /api/places?q=troy
 * ---------------------------------------------------------------------------
 * Location autocomplete, proxying OpenStreetMap's Nominatim.
 *
 * Proxied rather than called from the browser for three reasons: Nominatim's
 * usage policy requires an identifying User-Agent (which a browser will not let
 * us set), responses can be cached server-side across all users, and it keeps
 * the rate limiting in one place.
 *
 * Response: { ok: true, places: [{ label, short, lat, lon, boundingbox }] }
 */

import { suggestLocations } from '@/lib/places';
import { jsonOk, jsonError, rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(request) {
  // Autocomplete fires often, so the ceiling is high — but not unbounded, or
  // we would be forwarding a keystroke storm to a donation-funded service.
  const limit = rateLimit(`places:${clientKey(request)}`, { limit: 90, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonError(`Too many lookups. Wait ${limit.retryAfter}s.`, 429, { retryAfter: limit.retryAfter });
  }

  const query = new URL(request.url).searchParams.get('q') || '';

  if (query.trim().length < 2) return jsonOk({ places: [] });

  try {
    const places = await suggestLocations(query, 6);
    return jsonOk({ places });
  } catch (error) {
    return jsonError(error.message || 'Location lookup failed.', 502);
  }
}
