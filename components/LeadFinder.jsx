'use client';

/**
 * components/LeadFinder.jsx  —  Tab 1
 * ---------------------------------------------------------------------------
 * Two-step lead sourcing:
 *
 *   1. Describe the target (industry, location, keywords) and get one-click
 *      links into Google / Maps / Bing / DDG / OpenStreetMap. The user reviews
 *      those results themselves — the app never auto-harvests search engines,
 *      which would breach their Terms of Service.
 *   2. Paste the resulting site URLs in bulk. The app crawls each one for a
 *      contact address and fills the leads table.
 *
 * Crawling is batched five URLs at a time so no single serverless invocation
 * gets close to the execution limit, and so progress is visible as it goes.
 */

import { useMemo, useRef, useState } from 'react';
import {
  Building2,
  Download,
  ExternalLink,
  Globe,
  Link2,
  MapPin,
  Radar,
  Search,
  Sparkles,
  SquareStack,
  StopCircle,
  Tags,
} from 'lucide-react';
import { Alert, Card, SelectField, TextField, Toggle } from './ui';
import LeadTable from './LeadTable';
import { buildSearchUrls, chunk, parseUrlList } from '@/lib/search-urls';
import { downloadCsv, downloadJson } from '@/lib/storage';

/** URLs per API request. Five keeps a batch comfortably inside the timeout. */
const BATCH_SIZE = 5;

export default function LeadFinder({ settings, onSettingsChange, leads, onLeadsChange, serverStatus }) {
  const [urlInput, setUrlInput] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [progress, setProgress] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const abortRef = useRef(false);

  const update = (patch) => onSettingsChange({ ...settings, ...patch });

  const searchLinks = useMemo(
    () =>
      buildSearchUrls({
        industry: settings.industry,
        location: settings.location,
        keywords: settings.keywords,
      }),
    [settings.industry, settings.location, settings.keywords],
  );

  const parsed = useMemo(() => parseUrlList(urlInput), [urlInput]);

  async function handleScrape() {
    const { urls, invalid } = parsed;

    if (!urls.length) {
      setFeedback({ tone: 'warn', message: 'Paste at least one website URL to crawl.' });
      return;
    }

    // Skip anything already in the table so re-running does not duplicate work.
    const known = new Set(
      leads.map((lead) => {
        try {
          return new URL(lead.website).hostname.replace(/^www\./, '');
        } catch {
          return lead.website;
        }
      }),
    );

    const fresh = urls.filter((url) => {
      try {
        return !known.has(new URL(url).hostname.replace(/^www\./, ''));
      } catch {
        return true;
      }
    });

    if (!fresh.length) {
      setFeedback({ tone: 'info', message: 'Every one of those sites is already in your leads table.' });
      return;
    }

    abortRef.current = false;
    setIsScraping(true);
    setFeedback(null);

    const batches = chunk(fresh, BATCH_SIZE);
    const collected = [];
    let failedBatches = 0;

    setProgress({ done: 0, total: fresh.length, found: 0 });

    for (const [index, batch] of batches.entries()) {
      if (abortRef.current) break;

      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            urls: batch,
            options: {
              maxPages: settings.maxPages,
              respectRobots: settings.respectRobots,
              useFirecrawl: settings.useFirecrawl,
              industry: settings.industry,
              location: settings.location,
            },
          }),
        });

        // eslint-disable-next-line no-await-in-loop
        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error(data.error || `Request failed with status ${response.status}`);
        }

        collected.push(...data.leads);

        setProgress({
          done: Math.min((index + 1) * BATCH_SIZE, fresh.length),
          total: fresh.length,
          found: collected.filter((lead) => lead.email).length,
        });
      } catch (error) {
        failedBatches += 1;
        setFeedback({ tone: 'warn', message: `A batch failed: ${error.message}` });
      }
    }

    if (collected.length) onLeadsChange([...leads, ...collected]);

    const withEmail = collected.filter((lead) => lead.email).length;

    setFeedback({
      tone: withEmail ? 'success' : 'warn',
      message: abortRef.current
        ? `Stopped. Found ${withEmail} address(es) from ${collected.length} site(s) before stopping.`
        : `Crawled ${collected.length} site(s) — found ${withEmail} e-mail address(es).` +
          (invalid.length ? ` Skipped ${invalid.length} unparseable entr${invalid.length === 1 ? 'y' : 'ies'}.` : '') +
          (failedBatches ? ` ${failedBatches} batch(es) errored.` : '') +
          (withEmail < collected.length && !serverStatus?.firecrawl
            ? ' Sites with no result are often JavaScript-rendered — configure Firecrawl to reach those.'
            : ''),
    });

    setIsScraping(false);
    setProgress(null);
    if (collected.length) setUrlInput('');
  }

  const percentComplete = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      {/* ---------------------------------------------------------------- */}
      {/* Step 1 — describe the target                                     */}
      {/* ---------------------------------------------------------------- */}
      <Card
        title="1. Define your target"
        description="Used to build search links and to fill {{industry}} / {{location}} in your templates."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Target industry"
            value={settings.industry}
            onChange={(event) => update({ industry: event.target.value })}
            placeholder="e.g. interior design studios"
          />
          <TextField
            label="City / location"
            value={settings.location}
            onChange={(event) => update({ location: event.target.value })}
            placeholder="e.g. Rotterdam"
          />
          <TextField
            label="Keywords"
            value={settings.keywords}
            onChange={(event) => update({ keywords: event.target.value })}
            placeholder="e.g. boutique, portfolio"
          />
        </div>

        {searchLinks.length > 0 && (
          <div className="mt-4 rounded-lg border border-ink-700 bg-ink-900/60 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Search size={12} />
              Open a directory, then copy the business URLs you want into step 2
            </p>
            <div className="flex flex-wrap gap-1.5">
              {searchLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.note}
                  className="inline-flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-brand-500 hover:text-brand-300"
                >
                  <ExternalLink size={11} />
                  {link.label}
                </a>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Results are reviewed by you rather than harvested automatically — scraping search-engine result pages
              directly breaches their Terms of Service, and the extra pass is what keeps your list relevant.
            </p>
          </div>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Step 2 — crawl the sites                                         */}
      {/* ---------------------------------------------------------------- */}
      <Card
        title="2. Crawl sites for contact details"
        description="Paste one URL per line, or a comma-separated list. Duplicates are removed automatically."
        actions={
          <>
            {isScraping ? (
              <button type="button" onClick={() => { abortRef.current = true; }} className="btn-danger btn-sm">
                <StopCircle size={14} />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleScrape}
                disabled={!parsed.urls.length}
                className="btn-primary btn-sm"
              >
                <Radar size={14} />
                Scrape {parsed.urls.length > 0 && `${parsed.urls.length} site${parsed.urls.length === 1 ? '' : 's'}`}
              </button>
            )}
          </>
        }
      >
        <textarea
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          disabled={isScraping}
          rows={6}
          placeholder={'https://example-studio.com\nanotherbusiness.nl\nhttps://third-lead.co.uk/about'}
          className="input resize-y font-mono text-xs leading-relaxed"
          aria-label="Website URLs to crawl"
        />

        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Link2 size={12} />
            {parsed.urls.length} unique URL{parsed.urls.length === 1 ? '' : 's'}
          </span>
          {parsed.duplicates > 0 && <span>{parsed.duplicates} duplicate(s) removed</span>}
          {parsed.invalid.length > 0 && (
            <span className="text-amber-400">{parsed.invalid.length} entr(y/ies) could not be parsed</span>
          )}
          {parsed.urls.length > BATCH_SIZE && (
            <span className="inline-flex items-center gap-1">
              <SquareStack size={12} />
              sent in {Math.ceil(parsed.urls.length / BATCH_SIZE)} batches
            </span>
          )}
        </div>

        {/* Scraper options */}
        <div className="mt-4 grid gap-4 border-t border-ink-700 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Pages per site"
            value={settings.maxPages}
            onChange={(event) => update({ maxPages: Number(event.target.value) })}
            hint="Homepage plus contact/about pages."
            disabled={isScraping}
          >
            <option value={1}>1 — homepage only (fastest)</option>
            <option value={4}>4 — recommended</option>
            <option value={6}>6 — thorough</option>
            <option value={8}>8 — exhaustive (slow)</option>
          </SelectField>

          <div className="flex flex-col justify-center gap-3">
            <Toggle
              checked={settings.respectRobots}
              onChange={(value) => update({ respectRobots: value })}
              disabled={isScraping}
              label="Respect robots.txt"
              hint="Leave on unless you own the site or have permission."
            />
          </div>

          <div className="flex flex-col justify-center gap-3">
            <Toggle
              checked={settings.useFirecrawl && Boolean(serverStatus?.firecrawl)}
              onChange={(value) => update({ useFirecrawl: value })}
              disabled={isScraping || !serverStatus?.firecrawl}
              label="Firecrawl fallback"
              hint={
                serverStatus?.firecrawl
                  ? 'Retries misses with a real browser.'
                  : 'Set FIRECRAWL_API_KEY to enable (free tier).'
              }
            />
          </div>
        </div>

        {/* Live progress */}
        {progress && (
          <div className="mt-4 rounded-lg border border-brand-500/25 bg-brand-500/[0.07] p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-brand-200">
                <Globe size={12} className="animate-pulse" />
                Crawling {progress.done} of {progress.total}
              </span>
              <span className="tabular-nums text-brand-300">{progress.found} found</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
                style={{ width: `${percentComplete}%` }}
              />
            </div>
          </div>
        )}

        {feedback && (
          <Alert tone={feedback.tone} className="mt-4" onDismiss={() => setFeedback(null)}>
            {feedback.message}
          </Alert>
        )}

        {!serverStatus?.firecrawl && (
          <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
            <Sparkles size={11} className="mt-0.5 shrink-0" />
            <span>
              The built-in scraper reads raw HTML, so it cannot see addresses on fully JavaScript-rendered sites.
              Adding a free Firecrawl key typically recovers a meaningful share of the misses.
            </span>
          </p>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Step 3 — review                                                  */}
      {/* ---------------------------------------------------------------- */}
      <Card
        title="3. Review and clean your leads"
        description="Click any cell to edit. Accurate names and business names make templates read as human."
        actions={
          leads.length > 0 && (
            <>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() =>
                  downloadCsv(
                    leads.map(({ name, business, website, email, status }) => ({ name, business, website, email, status })),
                    `leads-${new Date().toISOString().slice(0, 10)}`,
                  )
                }
              >
                <Download size={13} />
                CSV
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => downloadJson(leads, `leads-${new Date().toISOString().slice(0, 10)}`)}
              >
                <Download size={13} />
                JSON
              </button>
            </>
          )
        }
      >
        <LeadTable
          leads={leads}
          showSelection={false}
          disabled={isScraping}
          onUpdateLead={(id, patch) =>
            onLeadsChange(
              leads.map((lead) =>
                lead.id === id
                  ? {
                      ...lead,
                      ...patch,
                      // Adding a missing address should clear the "no-email" state.
                      status: patch.email && lead.status === 'no-email' ? 'new' : lead.status,
                    }
                  : lead,
              ),
            )
          }
          onDeleteLead={(id) => onLeadsChange(leads.filter((lead) => lead.id !== id))}
          emptyTitle="No leads yet"
          emptyHint="Paste some website URLs above and hit Scrape. Everything stays in your browser."
        />

        {leads.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink-700 pt-4 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <Building2 size={12} />
              {leads.filter((lead) => lead.email).length} contactable
            </span>
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} />
              {leads.filter((lead) => !lead.email).length} missing an address
            </span>
            <span className="inline-flex items-center gap-1">
              <Tags size={12} />
              {new Set(leads.map((lead) => lead.status)).size} distinct status(es)
            </span>
            <button
              type="button"
              onClick={() => onLeadsChange(leads.filter((lead) => lead.email))}
              className="ml-auto text-slate-400 underline-offset-2 transition-colors hover:text-slate-200 hover:underline"
            >
              Remove leads with no e-mail
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
