'use client';

/**
 * app/page.js
 * ---------------------------------------------------------------------------
 * The whole console: header, four tabs, and the shared state they operate on.
 *
 * State is deliberately lifted here rather than scattered across the tabs,
 * because almost every piece of it crosses tab boundaries — the lead search's
 * industry/location fill template placeholders, the active reel link is chosen
 * while writing and rendered while sending, and the leads table is shared
 * outright between finding and sending.
 *
 * Persistence rules (see `lib/storage.js`):
 *   - Leads, templates, links, settings → localStorage.
 *   - SMTP credentials                  → sessionStorage unless the user opts in.
 *   - Attachments                       → memory only; base64 is far too large
 *                                         for the storage quota.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Mail, Radar, Send } from 'lucide-react';

import Header from '@/components/Header';
import LeadFinder from '@/components/LeadFinder';
import MessageStudio from '@/components/MessageStudio';
import SmtpSettings from '@/components/SmtpSettings';
import CampaignDashboard from '@/components/CampaignDashboard';
import { Alert } from '@/components/ui';

import {
  STORAGE_KEYS,
  buildBackup,
  downloadJson,
  incrementSendCounter,
  readJsonFile,
  readSendCounter,
  readStorage,
  removeStorage,
  restoreBackup,
  useStoredState,
  writeStorage,
} from '@/lib/storage';
import { createDefaultTemplates } from '@/lib/templates';
import { DEFAULT_MAX_DELAY_SECONDS, DEFAULT_MIN_DELAY_SECONDS } from '@/lib/constants';

/**
 * Four tabs, in the order the work actually happens: find leads → write the
 * message → send it. Credentials sit last because they are configured once and
 * then forgotten.
 */
const TABS = [
  { id: 'leads', label: 'Find leads', icon: Radar },
  { id: 'message', label: 'Write message', icon: FileText },
  { id: 'campaign', label: 'Send', icon: Send },
  { id: 'credentials', label: 'Settings', icon: Mail },
];

const DEFAULT_SCRAPER_SETTINGS = {
  typeId: '',
  keywords: '',
  location: '',
  place: null,        // { lat, lon, short, boundingbox } once picked from suggestions
  radius: 5000,
  industry: '',
  maxPages: 6,        // pages crawled per website — user-selectable in Tab 1
  runCap: 50,         // stop a run after this many new contactable leads; 0 = no limit
  source: 'auto',     // 'auto' | 'osm' | 'google'
  respectRobots: true,
  useFirecrawl: true,
};

const DEFAULT_CAMPAIGN = {
  templateId: '',
  senderName: '',
  product: '',
  reelLinkId: '',
  reelLink: '',
  minDelay: DEFAULT_MIN_DELAY_SECONDS,
  maxDelay: DEFAULT_MAX_DELAY_SECONDS,
  dryRun: true, // Safest possible default — an accidental send is unrecoverable.
  appendFooter: true,
  postalAddress: '',
  unsubscribeUrl: '',
};

const DEFAULT_SMTP = {
  user: '',
  pass: '',
  fromName: '',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  replyTo: '',
};

export default function Home() {
  const [activeTab, setActiveTab] = useState('leads');
  const [serverStatus, setServerStatus] = useState(null);
  const [notice, setNotice] = useState(null);
  const [sentToday, setSentToday] = useState(0);

  // Attachments are memory-only by design — see the note at the top.
  const [attachments, setAttachments] = useState([]);

  const [leads, setLeads] = useStoredState(STORAGE_KEYS.leads, []);
  const [templates, setTemplates] = useStoredState(STORAGE_KEYS.templates, []);
  const [reelLinks, setReelLinks] = useStoredState(STORAGE_KEYS.reelLinks, []);
  const [optOuts, setOptOuts] = useStoredState(STORAGE_KEYS.optOuts, []);
  const [scraperSettings, setScraperSettings] = useStoredState(STORAGE_KEYS.scraper, DEFAULT_SCRAPER_SETTINGS);
  const [campaign, setCampaign] = useStoredState(STORAGE_KEYS.campaign, DEFAULT_CAMPAIGN);

  // Credential storage location depends on the "remember" toggle.
  const [rememberCredentials, setRememberCredentials] = useStoredState(STORAGE_KEYS.smtpRemember, false);
  const [smtp, setSmtp] = useStoredState(STORAGE_KEYS.smtp, DEFAULT_SMTP, {
    kind: rememberCredentials ? 'local' : 'session',
  });

  // ------------------------------------------------------------- effects

  // Probe which optional integrations are configured server-side.
  useEffect(() => {
    let cancelled = false;

    fetch('/api/test-smtp')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.ok) setServerStatus(data.server);
      })
      .catch(() => {
        // A failed probe is not worth surfacing — every integration it reports
        // on is optional, and the UI degrades to "not configured".
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Seed starter templates on genuine first run only. Waiting for the stored
  // value to hydrate avoids re-seeding templates the user deliberately deleted.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (readStorage(STORAGE_KEYS.templates, null) === null) {
      setTemplates(createDefaultTemplates());
    }
  }, [setTemplates]);

  useEffect(() => {
    setSentToday(readSendCounter().count);
  }, []);

  // Note: when SENDER_POSTAL_ADDRESS / UNSUBSCRIBE_* are set server-side, the
  // mailer already falls back to them per message — no client-side sync needed.

  /**
   * Moves credentials between session and local storage when the toggle
   * flips, so switching does not silently strand the values in the old store.
   */
  const handleRememberChange = useCallback(
    (shouldRemember) => {
      const current = smtp;

      // Clear from wherever they are now, then let `useStoredState` write them
      // to the new location on its next persist cycle.
      removeStorage(STORAGE_KEYS.smtp, 'local');
      removeStorage(STORAGE_KEYS.smtp, 'session');

      setRememberCredentials(shouldRemember);
      writeStorage(STORAGE_KEYS.smtp, current, shouldRemember ? 'local' : 'session');

      setNotice({
        tone: 'info',
        message: shouldRemember
          ? 'Credentials will now persist on this device until you clear them.'
          : 'Credentials will be cleared when you close this tab.',
      });
    },
    [smtp, setRememberCredentials],
  );

  const clearCredentials = useCallback(() => {
    removeStorage(STORAGE_KEYS.smtp, 'local');
    removeStorage(STORAGE_KEYS.smtp, 'session');
    setSmtp(DEFAULT_SMTP);
    setNotice({ tone: 'success', message: 'Stored credentials cleared from this browser.' });
  }, [setSmtp]);

  const recordSend = useCallback((count) => {
    setSentToday(incrementSendCounter(count).count);
  }, []);

  /** Adds addresses to the opt-out list. Additive only — never removes. */
  const addOptOuts = useCallback(
    (input) => {
      const incoming = (Array.isArray(input) ? input : [input])
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter((entry) => entry.includes('@'));

      if (!incoming.length) return;
      setOptOuts((current) => [...new Set([...current, ...incoming])]);
    },
    [setOptOuts],
  );

  const exportBackup = useCallback(() => {
    downloadJson(buildBackup(), `coldmailsender-backup-${new Date().toISOString().slice(0, 10)}`);
    setNotice({
      tone: 'success',
      message: 'Backup downloaded. It contains leads, templates and links — never your password.',
    });
  }, []);

  const importBackup = useCallback(async (file) => {
    try {
      const payload = await readJsonFile(file);
      const restored = restoreBackup(payload);

      setNotice({ tone: 'success', message: `Restored ${restored.join(', ')}. Reloading…` });
      // Simplest correct way to re-hydrate every `useStoredState` at once.
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setNotice({ tone: 'error', message: error.message });
    }
  }, []);

  // The first lead with an address makes the template preview concrete.
  const sampleLead = useMemo(() => leads.find((lead) => lead.email) || null, [leads]);

  // Surface the campaign-wide industry/location the scraper collected.
  const campaignWithContext = useMemo(
    () => ({
      ...campaign,
      industry: campaign.industry || scraperSettings.industry,
      location: campaign.location || scraperSettings.location,
    }),
    [campaign, scraperSettings.industry, scraperSettings.location],
  );

  const tabCounts = {
    leads: leads.length,
    message: templates.length,
    campaign: leads.filter((lead) => lead.email).length,
    credentials: null,
  };

  return (
    <div className="min-h-screen">
      {/* Header and tabs are one sticky unit. Previously the tab bar carried its
          own `top-[73px]`, which drifted out of sync with the header's real
          height and overlapped it on scroll. */}
      <div className="sticky top-0 z-30">
        <Header
          sentToday={sentToday}
          serverStatus={serverStatus}
          onExportBackup={exportBackup}
          onImportBackup={importBackup}
        />

        <nav className="border-b border-edge-soft bg-void/60 backdrop-blur-2xl" aria-label="Sections">
          <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6">
          {TABS.map((tab, index) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const count = tabCounts[tab.id];

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative my-2 flex shrink-0 items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition-all ${
                  isActive
                    ? 'border-brand-400/30 bg-brand-500/15 text-brand-200 shadow-glow-sm'
                    : 'border-transparent text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                }`}
              >
                {/* Settings isn't a step in the flow, so it doesn't get a number. */}
                {tab.id !== 'credentials' && (
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-md text-[10px] font-semibold transition-colors ${
                      isActive ? 'bg-brand-500/30 text-brand-100' : 'bg-white/[0.07] text-slate-500'
                    }`}
                  >
                    {index + 1}
                  </span>
                )}
                <Icon size={14} />
                <span className="whitespace-nowrap">{tab.label}</span>
                {count > 0 && (
                  <span className="rounded-full border border-edge bg-white/[0.06] px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          </div>
        </nav>
      </div>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {notice && (
          <Alert tone={notice.tone} className="mb-5" onDismiss={() => setNotice(null)}>
            {notice.message}
          </Alert>
        )}

        {activeTab === 'leads' && (
          <LeadFinder
            settings={scraperSettings}
            onSettingsChange={setScraperSettings}
            leads={leads}
            onLeadsChange={setLeads}
            serverStatus={serverStatus}
          />
        )}

        {activeTab === 'message' && (
          <MessageStudio
            templates={templates}
            onTemplatesChange={setTemplates}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            reelLinks={reelLinks}
            onReelLinksChange={setReelLinks}
            campaign={campaignWithContext}
            onCampaignChange={setCampaign}
            sampleLead={sampleLead}
            scraperSettings={scraperSettings}
          />
        )}

        {activeTab === 'credentials' && (
          <SmtpSettings
            smtp={smtp}
            onSmtpChange={setSmtp}
            remember={rememberCredentials}
            onRememberChange={handleRememberChange}
            campaign={campaign}
            onCampaignChange={setCampaign}
            serverStatus={serverStatus}
            onClearCredentials={clearCredentials}
            templates={templates}
            attachments={attachments}
            optOuts={optOuts}
            onOptOutsChange={setOptOuts}
          />
        )}

        {activeTab === 'campaign' && (
          <CampaignDashboard
            leads={leads}
            onLeadsChange={setLeads}
            templates={templates}
            campaign={campaignWithContext}
            onCampaignChange={setCampaign}
            smtp={smtp}
            attachments={attachments}
            serverStatus={serverStatus}
            sentToday={sentToday}
            onRecordSend={recordSend}
            optOuts={optOuts}
            onOptOut={addOptOuts}
          />
        )}
      </main>

      <footer className="mt-10 border-t border-edge-soft py-8">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 text-xs text-slate-500 sm:px-6">
          <p>
            Cold Email Sender — built by{' '}
            <a
              href="https://github.com/a1wai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-400 transition-colors hover:text-brand-300"
            >
              @a1wai
            </a>
          </p>
          <p className="max-w-lg text-right leading-relaxed">
            You are responsible for how you use this. Send only what you would be comfortable defending — honour every
            opt-out, and check the rules that apply where your recipients live.
          </p>
        </div>
      </footer>
    </div>
  );
}
