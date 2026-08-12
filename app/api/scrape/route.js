/**
 * POST /api/scrape
 * ---------------------------------------------------------------------------
 * Extracts contact details from a batch of public URLs.
 *
 * Request:
 *   {
 *     urls: string[],                  // required, max 10 per request
 *     options?: {
 *       maxPages?: number,             // pages per site (default 4, max 8)
 *       respectRobots?: boolean,       // default true
 *       useFirecrawl?: boolean,        // fall back to Firecrawl when configured
 *       industry?: string,             // copied onto each lead for templating
 *       location?: string
 *     }
 *   }
 *
 * Response:
 *   { ok: true, leads: Lead[], stats: { requested, withEmail, failed, durationMs } }
 *
 * Batching is the caller's job: the UI sends 5 URLs at a time so no single
 * invocation approaches the serverless execution limit.
 */

import { scrapeSites, extractEmails, extractBusinessName, extractPersonName } from '@/lib/scraper';
import { scrapeWithFirecrawl, firecrawlToHtml, isFirecrawlEnabled } from '@/lib/adapters/firecrawl';
import { jsonOk, jsonError, readJsonBody, rateLimit, clientKey } from '@/lib/http';

// The scraper needs `node:dns` and `node:net`, so the Edge runtime is out.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hobby plan allows up to 60s for Node functions; 30 is a safe ceiling that
// still leaves room for a slow site in the batch.
export const maxDuration = 30;

const MAX_URLS_PER_REQUEST = 10;

export async function POST(request) {
  const startedAt = Date.now();

  // Scraping hits third-party servers, so throttle harder than the mail routes.
  const limit = rateLimit(`scrape:${clientKey(request)}`, { limit: 20, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonError(
      `Too many scrape requests. Try again in ${limit.retryAfter}s.`,
      429,
      { retryAfter: limit.retryAfter },
    );
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return jsonError(error.message, error.status || 400);
  }

  const { urls, options = {} } = body;

  if (!Array.isArray(urls) || !urls.length) {
    return jsonError('Provide a non-empty `urls` array.', 400);
  }

  if (urls.length > MAX_URLS_PER_REQUEST) {
    return jsonError(
      `Send at most ${MAX_URLS_PER_REQUEST} URLs per request — batch larger lists client-side.`,
      400,
    );
  }

  const cleanUrls = urls
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    // Drop duplicates within the batch so we do not hit the same site twice.
    .filter((url, index, all) => all.indexOf(url) === index);

  if (!cleanUrls.length) return jsonError('No usable URLs after trimming.', 400);

  const scrapeOptions = {
    maxPages: Math.min(Math.max(Number(options.maxPages) || 4, 1), 8),
    respectRobots: options.respectRobots !== false,
    concurrency: 4,
  };

  try {
    const results = await scrapeSites(cleanUrls, scrapeOptions);

    // Optional second pass: retry the misses through Firecrawl, which runs a
    // real browser and can see client-rendered contact details.
    const wantsFirecrawl = options.useFirecrawl !== false && isFirecrawlEnabled();
    if (wantsFirecrawl) {
      await retryMissesWithFirecrawl(results);
    }

    const leads = results.map((result, index) => ({
      id: `lead_${Date.now()}_${index}`,
      name: result.name || '',
      business: result.business || '',
      website: result.website || cleanUrls[index] || '',
      email: result.email || '',
      alternateEmails: (result.emails || []).slice(1, 5),
      status: result.email ? 'new' : 'no-email',
      industry: options.industry || '',
      location: options.location || '',
      source: result.viaFirecrawl ? 'firecrawl' : 'scraper',
      pagesVisited: result.pagesVisited?.length || 0,
      error: result.error || null,
      customFields: {},
    }));

    const withEmail = leads.filter((lead) => lead.email).length;

    return jsonOk({
      leads,
      stats: {
        requested: cleanUrls.length,
        withEmail,
        failed: cleanUrls.length - withEmail,
        durationMs: Date.now() - startedAt,
        firecrawlUsed: wantsFirecrawl,
      },
    });
  } catch (error) {
    console.error('[api/scrape] Unexpected failure:', error);
    return jsonError(error.message || 'Scrape failed unexpectedly.', 500);
  }
}

/**
 * Mutates `results` in place, re-running any entry that found no e-mail
 * through Firecrawl. Failures here are non-fatal — the original result stands.
 */
async function retryMissesWithFirecrawl(results) {
  const misses = results.filter((result) => !result.email && !/robots\.txt/i.test(result.error || ''));

  for (const result of misses) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const rendered = await scrapeWithFirecrawl(result.website);
      if (!rendered) continue;

      const html = firecrawlToHtml(rendered);
      let hostname = '';
      try {
        hostname = new URL(result.website).hostname;
      } catch {
        /* leave blank — only used for domain-match scoring */
      }

      const emails = extractEmails(html, hostname);
      if (emails.length) {
        result.emails = emails.map((entry) => entry.email);
        result.email = result.emails[0];
        result.error = null;
        result.viaFirecrawl = true;
        result.business = result.business || extractBusinessName(html, hostname);
        result.name = result.name || extractPersonName(html);
      }
    } catch (error) {
      // Quota exhausted or key rejected — stop retrying the rest of the batch.
      if (/credits|quota|key/i.test(error.message)) break;
    }
  }
}
