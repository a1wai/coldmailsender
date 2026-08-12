'use client';

/**
 * components/Header.jsx
 * ---------------------------------------------------------------------------
 * Branded app header. Also surfaces two things that matter constantly during a
 * campaign: how much of the daily sending quota is left, and which optional
 * server-side integrations are actually configured.
 */

import { Database, Download, Flame, HardDriveDownload, Mail, Send, Upload, Zap } from 'lucide-react';
import { Badge } from './ui';
import { GMAIL_DAILY_LIMIT } from '@/lib/queue';

export default function Header({ sentToday = 0, serverStatus = null, onExportBackup, onImportBackup }) {
  const remaining = Math.max(0, GMAIL_DAILY_LIMIT - sentToday);
  const usedRatio = Math.min(1, sentToday / GMAIL_DAILY_LIMIT);

  const quotaTone = usedRatio >= 0.9 ? 'error' : usedRatio >= 0.7 ? 'warn' : 'success';

  const integrations = [
    { key: 'firecrawl', label: 'Firecrawl', icon: Flame, on: serverStatus?.firecrawl },
    { key: 'qstash', label: 'QStash', icon: Zap, on: serverStatus?.qstash },
    { key: 'supabase', label: 'Supabase', icon: Database, on: serverStatus?.supabase },
    { key: 'smtp', label: 'Server SMTP', icon: Mail, on: serverStatus?.smtpConfigured },
  ];

  return (
    // Positioning is owned by the sticky wrapper in app/page.js.
    <header className="border-b border-edge-soft bg-void/70 backdrop-blur-2xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
        {/* Brand */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-gradient shadow-glow">
            <Send size={18} className="text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight text-white">
              Cold Email Sender{' '}
              <span className="font-normal text-slate-400">built by</span>{' '}
              <a
                href="https://github.com/a1wai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-400 transition-colors hover:text-brand-300"
              >
                @a1wai
              </a>
            </h1>
            <p className="truncate text-[11px] text-slate-500">
              Lead finder &amp; outreach platform — free and open-source stack
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Integration status — only rendered once the probe has returned. */}
          {serverStatus && (
            <div className="hidden items-center gap-1.5 lg:flex">
              {integrations
                .filter((integration) => integration.on)
                .map(({ key, label, icon: Icon }) => (
                  <span
                    key={key}
                    title={`${label} is configured server-side`}
                    className="inline-flex items-center gap-1 rounded-lg border border-mint-400/25 bg-mint-500/10 px-2 py-1 text-[11px] font-medium text-mint-300"
                  >
                    <Icon size={11} />
                    {label}
                  </span>
                ))}
            </div>
          )}

          {/* Daily quota */}
          <div
            className="flex items-center gap-2 rounded-xl border border-edge bg-white/[0.04] px-3 py-1.5 backdrop-blur-sm"
            title={`Gmail allows ${GMAIL_DAILY_LIMIT} messages/day on a free account (2,000 on Workspace). Counted locally in this browser.`}
          >
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Today</div>
              <div className="text-xs font-semibold tabular-nums text-slate-200">
                {sentToday}
                <span className="font-normal text-slate-500"> / {GMAIL_DAILY_LIMIT}</span>
              </div>
            </div>
            <div className="h-7 w-px bg-edge" />
            <Badge tone={quotaTone}>{remaining} left</Badge>
          </div>

          {/* Backup / restore */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onExportBackup}
              className="btn-ghost btn-sm"
              title="Download all leads, templates and links as a JSON backup"
            >
              <Download size={14} />
              <span className="hidden sm:inline">Backup</span>
            </button>
            <label
              className="btn-ghost btn-sm cursor-pointer"
              title="Restore from a previously downloaded backup file"
            >
              <Upload size={14} />
              <span className="hidden sm:inline">Restore</span>
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onImportBackup(file);
                  // Reset so re-selecting the same file fires onChange again.
                  event.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Storage-location reminder — users need to know data is browser-local. */}
      <div className="border-t border-edge-soft bg-white/[0.02]">
        <div className="mx-auto flex max-w-7xl items-center gap-1.5 px-4 py-1.5 text-[11px] text-slate-500 sm:px-6">
          <HardDriveDownload size={11} className="shrink-0" />
          <span>
            Leads and templates are stored in <strong className="font-medium text-slate-400">this browser only</strong>
            {serverStatus?.supabase && ' (plus Supabase)'}. Clearing site data erases them — take a backup before you do.
          </span>
        </div>
      </div>
    </header>
  );
}
