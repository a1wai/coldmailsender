/**
 * lib/adapters/firecrawl.js
 * ---------------------------------------------------------------------------
 * Optional adapter for Firecrawl (https://firecrawl.dev) — free tier, no card.
 *
 * The built-in cheerio scraper reads raw HTML, so it cannot see contact details
 * on sites that render entirely client-side (React/Vue SPAs, Framer, some Wix
 * templates). Firecrawl runs a real browser and returns rendered markdown.
 *
 * Called over plain REST so the project needs no extra dependency. Entirely
 * optional: with no `FIRECRAWL_API_KEY` set, `isFirecrawlEnabled()` is false
 * and the app falls back to the built-in scraper.
 */

import axios from 'axios';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

export function isFirecrawlEnabled() {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

/**
 * Scrapes one URL through Firecrawl and returns rendered markdown + metadata.
 * Returns `null` when the adapter is not configured, so callers can fall back.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ markdown: string, html: string, metadata: object }|null>}
 */
export async function scrapeWithFirecrawl(url, options = {}) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.FIRECRAWL_API_URL || DEFAULT_API_URL).replace(/\/$/, '');

  try {
    const { data } = await axios.post(
      `${baseUrl}/v1/scrape`,
      {
        url,
        formats: ['markdown', 'html'],
        onlyMainContent: false, // Footers hold the contact details.
        timeout: options.timeoutMs || 20_000,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: (options.timeoutMs || 20_000) + 5_000,
      },
    );

    if (!data?.success) {
      throw new Error(data?.error || 'Firecrawl returned an unsuccessful response.');
    }

    return {
      markdown: data.data?.markdown || '',
      html: data.data?.html || '',
      metadata: data.data?.metadata || {},
    };
  } catch (error) {
    const status = error?.response?.status;

    if (status === 401 || status === 403) {
      throw new Error('Firecrawl rejected the API key. Check FIRECRAWL_API_KEY.');
    }
    if (status === 402) {
      throw new Error('Firecrawl free-tier credits are exhausted for this period.');
    }
    if (status === 429) {
      throw new Error('Firecrawl rate limit hit. Wait a moment and retry.');
    }

    throw new Error(`Firecrawl request failed: ${error?.message || 'unknown error'}`);
  }
}

/**
 * Firecrawl returns markdown rather than a DOM, so extraction reuses the same
 * regex path as the built-in scraper. Wrapping the markdown in a minimal HTML
 * shell lets `lib/scraper.js` handle it with no special-casing.
 */
export function firecrawlToHtml(result) {
  if (!result) return '';
  if (result.html) return result.html;

  const escaped = String(result.markdown || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const title = result.metadata?.title || '';
  const siteName = result.metadata?.ogSiteName || result.metadata?.['og:site_name'] || '';

  return (
    `<html><head><title>${title}</title>` +
    (siteName ? `<meta property="og:site_name" content="${siteName}">` : '') +
    `</head><body><pre>${escaped}</pre></body></html>`
  );
}
