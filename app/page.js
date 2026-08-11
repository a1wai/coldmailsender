'use client';

/**
 * app/page.js
 * ---------------------------------------------------------------------------
 * The whole console: header, five tabs, and the shared state they operate on.
 *
 * State is deliberately lifted here rather than scattered across the tabs,
 * because almost every piece of it crosses tab boundaries — the scraper's
 * industry/location fill template placeholders, the active reel link is chosen
 * in Tab 3 and rendered in Tab 5, and the leads table is shared outright.
 *
 * Persistence rules (see `lib/storage.js`):
 *   - Leads, templates, links, settings → localStorage.
 *   - SMTP credentials                  → sessionStorage unless the user opts in.
 *   - Attachments                       → memory only; base64 is far too large
 *                                         for the storage quota.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Mail, Paperclip, Radar, Send } from 'lucide-react';

import Header from '@/components/Header';
import LeadFinder from '@/components/LeadFinder';
import TemplateManager from '@/components/TemplateManager';
import AttachmentManager from '@/components/AttachmentManager';
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

const TABS = [
  { id: 'leads', label: 'Lead Finder', icon: Radar },
  { id: 'templates', label: 'Templates', icon: FileText },
  { id: 'attachments', label: 'Attachments & Links', icon: Paperclip },
  { id: 'credentials', label: 'Credentials', icon: Mail },
  { id: 'campaign', label: 'Campaign', icon: Send },
];

const DEFAULT_SCRAPER_SETTINGS = {
  industry: '',
  location: '',
  keywords: '',
  maxPages: 4,
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
    templates: templates.length,
    attachments: attachments.length + reelLinks.length,
    credentials: null,
    campaign: leads.filter((lead) => lead.email).length,
  };

  return (
    <div className="min-h-screen">
      <Header
        sentToday={sentToday}
        serverStatus={serverStatus}
        onExportBackup={exportBackup}
        onImportBackup={importBackup}
      />

      {/* Tab bar */}
      <nav className="sticky top-[73px] z-20 border-b border-ink-700 bg-ink-900/80 backdrop-blur-md" aria-label="Sections">
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
                className={`relative flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-brand-500 text-brand-300'
                    : 'border-transparent text-slate-400 hover:border-ink-600 hover:text-slate-200'
                }`}
              >
                <span
                  className={`grid h-5 w-5 place-items-center rounded text-[10px] font-semibold ${
                    isActive ? 'bg-brand-500/20 text-brand-300' : 'bg-ink-700 text-slate-500'
                  }`}
                >
                  {index + 1}
                </span>
                <Icon size={14} />
                <span className="whitespace-nowrap">{tab.label}</span>
                {count > 0 && (
                  <span className="rounded-full bg-ink-700 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

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

        {activeTab === 'templates' && (
          <TemplateManager
            templates={templates}
            onTemplatesChange={setTemplates}
            campaign={campaignWithContext}
            sampleLead={sampleLead}
          />
        )}

        {activeTab === 'attachments' && (
          <AttachmentManager
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            reelLinks={reelLinks}
            onReelLinksChange={setReelLinks}
            campaign={campaign}
            onCampaignChange={setCampaign}
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
          />
        )}
      </main>

      <footer className="mt-8 border-t border-ink-800 py-6">
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
