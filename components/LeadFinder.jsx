'use client';

/**
 * components/LeadFinder.jsx  —  Tab 1 (Find leads)
 * ---------------------------------------------------------------------------
 * Lead generation in one action: pick a business type and a place, press
 * Find leads.
 *
 * Under the hood that is two steps, run back to back with live progress:
 *   1. `/api/discover` asks OpenStreetMap for real businesses in the area.
 *      Many carry a website; some publish an e-mail outright.
 *   2. `/api/scrape` visits the websites that had no address and looks for one.
 *
 * Manual routes stay available for the cases automation misses: a single
 * Google Maps button for eyeballing an area, a paste-URLs box, and an
 * add-by-hand form.
 */

import { useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  MapPin,
  Plus,
  Search,
  Sparkles,
  StopCircle,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Alert, Card, EmptyState, TextField } from './ui';
import LeadTable from './LeadTable';
import LocationInput from './LocationInput';
import { BUSINESS_TYPES } from '@/lib/business-types';
import { createLead, mergeLeads } from '@/lib/leads';
import { chunk, parseUrlList } from '@/lib/search-urls';
import { downloadCsv, downloadJson } from '@/lib/storage';

/** URLs per scrape request — keeps every call well inside the timeout. */
const SCRAPE_BATCH = 5;

const RADIUS_OPTIONS = [
  { value: 2000, label: '2 km — city centre' },
  { value: 5000, label: '5 km — whole town' },
  { value: 10000, label: '10 km — town + suburbs' },
  { value: 25000, label: '25 km — wide region' },
];

export default function LeadFinder({ settings, onSettingsChange, leads, onLeadsChange, serverStatus }) {
  const [busy, setBusy] = useState(null); // 'discovering' | 'crawling' | null
  const [progress, setProgress] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [draft, setDraft] = useState({ business: '', email: '', website: '', name: '' });
  const abortRef = useRef(false);

  const update = (patch) => onSettingsChange({ ...settings, ...patch });
  const parsed = useMemo(() => parseUrlList(urlInput), [urlInput]);

  const canSearch = Boolean(settings.place?.lat) && Boolean(settings.typeId || settings.keyword?.trim());

  const mapsUrl = useMemo(() => {
    const type = BUSINESS_TYPES.find((entry) => entry.id === settings.typeId);
    const terms = [type?.label || settings.keyword, settings.place?.short || settings.location]
      .filter(Boolean)
      .join(' in ');
    return `https://www.google.com/maps/search/${encodeURIComponent(terms || 'businesses')}`;
  }, [settings.typeId, settings.keyword, settings.place, settings.location]);

  /** Crawls a set of websites for e-mail addresses, updating leads as it goes. */
  async function crawlForEmails(targets, startingLeads) {
    if (!targets.length) return { crawled: 0, found: 0, leads: startingLeads };

    setBusy('crawling');
    let working = startingLeads;
    let found = 0;
    let done = 0;

    for (const batch of chunk(targets, SCRAPE_BATCH)) {
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
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

        const result = mergeLeads(working, data.leads.map((lead) => createLead(lead)));
        working = result.leads;
        found += data.leads.filter((lead) => lead.email).length;
      } catch (error) {
        setFeedback({ tone: 'warn', message: `A batch failed: ${error.message}` });
      }

      done += batch.length;
      setProgress({ phase: 'crawling', done, total: targets.length, found });
      onLeadsChange(working);
    }

    return { crawled: done, found, leads: working };
  }

  /** The main action: discover businesses, then crawl the ones missing an address. */
  async function handleFindLeads() {
    if (!canSearch) return;

    abortRef.current = false;
    setBusy('discovering');
    setFeedback(null);
    setProgress({ phase: 'discovering' });

    try {
      const response = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: settings.place.lat,
          lon: settings.place.lon,
          radius: settings.radius,
          typeId: settings.typeId,
          keyword: settings.keyword,
          industry:
            settings.industry || BUSINESS_TYPES.find((entry) => entry.id === settings.typeId)?.label || '',
          location: settings.place.short || settings.location,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      if (!data.leads.length) {
        setFeedback({
          tone: 'warn',
          message:
            'OpenStreetMap has no businesses of that type mapped in this area. Try a wider radius, a different ' +
            'type, or use the Google Maps button below and paste the sites you find.',
        });
        setBusy(null);
        setProgress(null);
        return;
      }

      const afterDiscovery = mergeLeads(leads, data.leads);
      onLeadsChange(afterDiscovery.leads);

      // Crawl anything that has a website but no address yet.
      const targets = data.leads.filter((lead) => !lead.email && lead.website).map((lead) => lead.website);
      const crawl = await crawlForEmails(targets, afterDiscovery.leads);

      const totalWithEmail = crawl.leads.filter((lead) => lead.email).length;

      setFeedback({
        tone: totalWithEmail ? 'success' : 'warn',
        message:
          `Found ${data.stats.found} businesses · ${data.stats.withEmail} published an e-mail · ` +
          `crawled ${crawl.crawled} websites and found ${crawl.found} more. ` +
          `You now have ${totalWithEmail} contactable lead${totalWithEmail === 1 ? '' : 's'}.` +
          (!serverStatus?.firecrawl && crawl.crawled > crawl.found
            ? ' Sites that came back empty are often JavaScript-rendered — a free Firecrawl key reaches those.'
            : ''),
      });
    } catch (error) {
      setFeedback({ tone: 'error', message: error.message });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function handleCrawlPasted() {
    const { urls } = parsed;
    if (!urls.length) return;

    abortRef.current = false;
    setFeedback(null);
    const result = await crawlForEmails(urls, leads);
    setBusy(null);
    setProgress(null);
    setUrlInput('');
    setFeedback({
      tone: result.found ? 'success' : 'warn',
      message: `Crawled ${result.crawled} site(s), found ${result.found} e-mail address(es).`,
    });
  }

  function addManualLead() {
    if (!draft.business.trim() && !draft.email.trim() && !draft.website.trim()) return;

    const lead = createLead({ ...draft, industry: settings.industry, location: settings.location, source: 'manual' });
    const { leads: next } = mergeLeads(leads, [lead]);

    onLeadsChange(next);
    setDraft({ business: '', email: '', website: '', name: '' });
    setFeedback({ tone: 'success', message: `Added ${lead.business || lead.email}.` });
  }

  const contactable = leads.filter((lead) => lead.email).length;

  return (
    <div className="flex flex-col gap-4">
      {/* ================================================================= */}
      {/* Primary action                                                    */}
      {/* ================================================================= */}
      <Card
        title="Find leads"
        description="Pick what you're looking for and where. Everything else is automatic."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="business-type">
              Type of business
            </label>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <select
                id="business-type"
                value={settings.typeId || ''}
                onChange={(event) => update({ typeId: event.target.value })}
                disabled={Boolean(busy)}
                className="input cursor-pointer appearance-none pl-9 pr-9"
              >
                <option value="">— choose a type —</option>
                {BUSINESS_TYPES.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Not listed? Leave blank and type a keyword below instead.
            </p>
          </div>

          <LocationInput
            value={settings.location || ''}
            selected={settings.place}
            disabled={Boolean(busy)}
            onChange={(value) => update({ location: value })}
            onSelect={(place) =>
              update({
                place,
                // Size the radius to the place: a town gets a town-sized search.
                radius: place?.boundingbox?.length === 4 ? estimateRadius(place.boundingbox) : settings.radius,
              })
            }
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label="Keyword (optional)"
            value={settings.keyword || ''}
            onChange={(event) => update({ keyword: event.target.value })}
            disabled={Boolean(busy)}
            placeholder="e.g. boutique, dental, vegan"
            hint={settings.typeId ? 'Ignored while a type is selected.' : 'Matches the business name.'}
          />

          <div>
            <label className="label" htmlFor="search-radius">
              Search area
            </label>
            <div className="relative">
              <select
                id="search-radius"
                value={settings.radius}
                onChange={(event) => update({ radius: Number(event.target.value) })}
                disabled={Boolean(busy)}
                className="input cursor-pointer appearance-none pr-9"
              >
                {RADIUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
            </div>
          </div>
        </div>

        {/* Big primary button */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {busy ? (
            <button
              type="button"
              onClick={() => { abortRef.current = true; }}
              className="btn-danger px-6 py-3 text-base"
            >
              <StopCircle size={18} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFindLeads}
              disabled={!canSearch}
              className="btn-primary px-6 py-3 text-base shadow-lg shadow-brand-900/30"
            >
              <Sparkles size={18} />
              Find leads
            </button>
          )}

          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
            title="Open this search in Google Maps to review it by hand"
          >
            <MapPin size={15} />
            Open Google Maps
            <ExternalLink size={12} className="opacity-60" />
          </a>

          {!canSearch && (
            <span className="text-xs text-slate-500">
              {settings.place?.lat ? 'Pick a business type or enter a keyword.' : 'Pick a location from the suggestions.'}
            </span>
          )}
        </div>

        {/* Live progress */}
        {progress && (
          <div className="mt-4 rounded-lg border border-brand-500/25 bg-brand-500/[0.07] p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-brand-200">
                <Loader2 size={12} className="animate-spin" />
                {progress.phase === 'discovering'
                  ? 'Searching OpenStreetMap for businesses…'
                  : `Visiting websites for e-mail addresses — ${progress.done} of ${progress.total}`}
              </span>
              {progress.found > 0 && <span className="tabular-nums text-brand-300">{progress.found} found</span>}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
              <div
                className={`h-full rounded-full bg-brand-500 transition-[width] duration-300 ${
                  progress.phase === 'discovering' ? 'w-1/4 animate-pulse' : ''
                }`}
                style={
                  progress.phase === 'crawling'
                    ? { width: `${Math.round((progress.done / progress.total) * 100)}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}

        {feedback && (
          <Alert tone={feedback.tone} className="mt-4" onDismiss={() => setFeedback(null)}>
            {feedback.message}
          </Alert>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          Business data comes from OpenStreetMap, which is open data and free to query. Google Search and Maps results
          cannot be harvested automatically — their Terms of Service prohibit it and they block it in practice — so the
          Maps button is there for reviewing an area yourself and pasting anything worth adding.
        </p>
      </Card>

      {/* ================================================================= */}
      {/* Manual routes — collapsed by default to keep the main flow clean   */}
      {/* ================================================================= */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Collapsible
          open={showManual}
          onToggle={() => setShowManual((v) => !v)}
          icon={UserPlus}
          title="Add a lead by hand"
          subtitle="Someone you already know about"
        >
          <div className="grid gap-3">
            <TextField
              label="Business name"
              value={draft.business}
              onChange={(event) => setDraft({ ...draft, business: event.target.value })}
              placeholder="Studio Noord"
            />
            <TextField
              label="E-mail"
              type="email"
              value={draft.email}
              onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              placeholder="hello@studionoord.nl"
            />
            <TextField
              label="Website"
              value={draft.website}
              onChange={(event) => setDraft({ ...draft, website: event.target.value })}
              placeholder="studionoord.nl"
              hint="If you leave the name blank, it is taken from the domain."
            />
            <TextField
              label="Contact person (optional)"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Sarah"
            />
            <button
              type="button"
              onClick={addManualLead}
              disabled={!draft.business.trim() && !draft.email.trim() && !draft.website.trim()}
              className="btn-primary"
            >
              <Plus size={15} />
              Add lead
            </button>
          </div>
        </Collapsible>

        <Collapsible
          open={showPaste}
          onToggle={() => setShowPaste((v) => !v)}
          icon={Search}
          title="Paste website URLs"
          subtitle="Crawl a list of sites for addresses"
        >
          <textarea
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            disabled={Boolean(busy)}
            rows={5}
            placeholder={'https://example-studio.com\nanotherbusiness.nl'}
            className="input resize-y font-mono text-xs leading-relaxed"
            aria-label="Website URLs to crawl"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={handleCrawlPasted}
              disabled={!parsed.urls.length || Boolean(busy)}
              className="btn-primary"
            >
              <Search size={15} />
              Crawl {parsed.urls.length > 0 && parsed.urls.length}
            </button>
            <span className="text-xs text-slate-500">
              {parsed.urls.length} unique URL{parsed.urls.length === 1 ? '' : 's'}
            </span>
          </div>
        </Collapsible>
      </div>

      {/* ================================================================= */}
      {/* Results                                                            */}
      {/* ================================================================= */}
      <Card
        title={`Your leads${leads.length ? ` — ${contactable} contactable of ${leads.length}` : ''}`}
        description="Click any cell to edit. Good names make templates read as human."
        actions={
          leads.length > 0 && (
            <>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() =>
                  downloadCsv(
                    leads.map(({ name, business, website, email, phone, status }) => ({
                      name, business, website, email, phone, status,
                    })),
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
              <button
                type="button"
                className="btn-ghost btn-sm text-red-400 hover:bg-red-950/40"
                onClick={() => onLeadsChange(leads.filter((lead) => lead.email))}
                title="Remove every lead without an e-mail address"
              >
                <Trash2 size={13} />
                Clear empties
              </button>
            </>
          )
        }
      >
        {leads.length === 0 ? (
          <EmptyState icon={Sparkles} title="No leads yet">
            Choose a business type and a location above, then press <strong className="text-slate-300">Find leads</strong>.
            Everything stays in your browser.
          </EmptyState>
        ) : (
          <LeadTable
            leads={leads}
            showSelection={false}
            disabled={Boolean(busy)}
            onUpdateLead={(id, patch) =>
              onLeadsChange(
                leads.map((lead) =>
                  lead.id === id
                    ? { ...lead, ...patch, status: patch.email && lead.status !== 'sent' ? 'new' : lead.status }
                    : lead,
                ),
              )
            }
            onDeleteLead={(id) => onLeadsChange(leads.filter((lead) => lead.id !== id))}
          />
        )}
      </Card>
    </div>
  );
}

/** Simple disclosure panel — keeps secondary actions out of the way. */
function Collapsible({ open, onToggle, icon: Icon, title, subtitle, children }) {
  return (
    <section className="card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-ink-800/40"
      >
        <Icon size={16} className="shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-200">{title}</span>
          <span className="block text-xs text-slate-500">{subtitle}</span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-ink-700 p-5">{children}</div>}
    </section>
  );
}

/** Mirrors `radiusFromBoundingBox` on the server, clamped to the presets. */
function estimateRadius(boundingbox) {
  const [south, north, west, east] = boundingbox.map(Number);
  if ([south, north, west, east].some((n) => !Number.isFinite(n))) return 5000;

  const latSpan = Math.abs(north - south) * 111_320;
  const lonSpan = Math.abs(east - west) * 111_320 * Math.cos((((north + south) / 2) * Math.PI) / 180);
  const radius = Math.max(latSpan, lonSpan) / 2;

  // Snap to the nearest preset so the dropdown always shows a real selection.
  return RADIUS_OPTIONS.reduce(
    (best, option) => (Math.abs(option.value - radius) < Math.abs(best - radius) ? option.value : best),
    5000,
  );
}
