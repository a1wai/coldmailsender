'use client';

/**
 * components/CampaignDashboard.jsx  —  Tab 3 (Send)
 * ---------------------------------------------------------------------------
 * Campaign execution: pick a template, select recipients, and run the queue.
 *
 * The send loop lives in the browser (`lib/queue.js`) and calls
 * `/api/send-email` once per recipient. See that module for why the schedule
 * cannot live in a serverless function.
 *
 * Everything here is built around making a slow, paced process legible:
 * pre-flight checks before the button unlocks, a live countdown between sends,
 * a per-recipient log, and pause/stop that take effect immediately.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Download,
  Gauge,
  Pause,
  Play,
  Rocket,
  Square,
  TestTube2,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Alert, Badge, Card, SelectField, TextField, Toggle } from './ui';
import LeadTable from './LeadTable';
import { createSendQueue, dedupeLeads, estimateDuration, GMAIL_DAILY_LIMIT } from '@/lib/queue';
import { renderEmail } from '@/lib/templates';
import { downloadCsv } from '@/lib/storage';
import { blobToBase64 } from '@/lib/file-store';
import { MAX_ATTACHMENT_BYTES } from '@/lib/constants';

/** Keeps the log bounded — a 500-lead campaign would otherwise pin the tab. */
const MAX_LOG_ENTRIES = 400;

export default function CampaignDashboard({
  leads,
  onLeadsChange,
  templates,
  campaign,
  onCampaignChange,
  smtp,
  attachments,
  serverStatus,
  sentToday,
  onRecordSend,
  optOuts = [],
  onOptOut,
}) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [log, setLog] = useState([]);
  const [queueState, setQueueState] = useState('idle');
  const [countdown, setCountdown] = useState(null);
  const [stats, setStats] = useState({ sent: 0, failed: 0, skipped: 0, total: 0 });

  const queueRef = useRef(null);
  const logEndRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);

  const isRunning = queueState === 'running' || queueState === 'paused';

  const selectedTemplate = templates.find((template) => template.id === campaign.templateId) || null;
  const selectedLeads = useMemo(() => leads.filter((lead) => selectedIds.has(lead.id)), [leads, selectedIds]);

  const optOutSet = useMemo(
    () => new Set(optOuts.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)),
    [optOuts],
  );

  // Opt-outs are removed before de-duplication, and silently — someone who has
  // unsubscribed should never appear in a count of "recipients", not even as a
  // number the user could talk themselves into overriding.
  const { unique: sendableLeads, duplicates, suppressed } = useMemo(() => {
    const allowed = selectedLeads.filter((lead) => !optOutSet.has(String(lead.email || '').toLowerCase()));
    return { ...dedupeLeads(allowed), suppressed: selectedLeads.length - allowed.length };
  }, [selectedLeads, optOutSet]);

  const dailyRemaining = Math.max(0, GMAIL_DAILY_LIMIT - sentToday);
  const estimate = estimateDuration(sendableLeads.length, campaign.minDelay, campaign.maxDelay);

  // The table splits in two: still to write to, and already written to. Sorted
  // newest-first, because the useful question about the sent pile is almost
  // always "what did I just send?" rather than "what did I send first?".
  const contacted = useMemo(
    () => leads.filter((lead) => lead.status === 'sent').sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0)),
    [leads],
  );
  const pending = useMemo(() => leads.filter((lead) => lead.status !== 'sent'), [leads]);

  // -------------------------------------------------------------- logging

  const appendLog = useCallback((entry) => {
    setLog((current) => {
      const next = [...current, { ...entry, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }];
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
    });
  }, []);

  // Follow the log only while the user is already at the bottom — yanking the
  // view back down while they are reading an earlier failure is infuriating.
  useEffect(() => {
    if (shouldAutoScrollRef.current) logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [log]);

  // ------------------------------------------------------- pre-flight

  const issues = useMemo(() => {
    const found = [];

    if (!selectedTemplate) found.push({ level: 'error', text: 'Choose a template.' });
    else {
      if (!selectedTemplate.subject?.trim()) found.push({ level: 'error', text: 'The selected template has no subject.' });
      if (!selectedTemplate.body?.trim()) found.push({ level: 'error', text: 'The selected template has an empty body.' });
    }

    if (!sendableLeads.length) found.push({ level: 'error', text: 'Select at least one recipient.' });

    const hasCredentials = Boolean((smtp.user && smtp.pass) || serverStatus?.smtpConfigured);
    if (!hasCredentials) found.push({ level: 'error', text: 'Add your Gmail address and app password in the Credentials tab.' });

    if (!campaign.senderName?.trim()) {
      found.push({ level: 'warn', text: 'No sender name set — {{sender_name}} will render as nothing.' });
    }

    if (selectedTemplate?.body?.includes('{{reel_link}}') && !campaign.reelLink) {
      found.push({ level: 'warn', text: 'The template uses {{reel_link}} but no portfolio link is active.' });
    }

    if (campaign.appendFooter !== false && !campaign.postalAddress) {
      found.push({ level: 'warn', text: 'No postal address set — required by CAN-SPAM for commercial e-mail.' });
    }

    if (duplicates > 0) {
      found.push({ level: 'warn', text: `${duplicates} duplicate address(es) will be sent to only once.` });
    }

    if (suppressed > 0) {
      found.push({ level: 'info', text: `${suppressed} selected recipient(s) have opted out and were removed.` });
    }

    if (sendableLeads.length > dailyRemaining) {
      found.push({
        level: 'warn',
        text: `Only ${dailyRemaining} sends left in today's quota — the last ${sendableLeads.length - dailyRemaining} will be skipped.`,
      });
    }

    return found;
  }, [selectedTemplate, sendableLeads.length, smtp, serverStatus, campaign, duplicates, suppressed, dailyRemaining]);

  const blockingIssues = issues.filter((issue) => issue.level === 'error');
  const canStart = blockingIssues.length === 0 && !isRunning;

  // ---------------------------------------------------------- selection

  const toggleSelect = useCallback((id) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((ids, shouldSelect) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (shouldSelect) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  /** Selects everything that has an address and has not already been sent to. */
  const selectUncontacted = useCallback(() => {
    setSelectedIds(
      new Set(
        leads
          .filter(
            (lead) =>
              lead.email &&
              lead.status !== 'sent' &&
              lead.status !== 'unsubscribed' &&
              !optOutSet.has(lead.email.toLowerCase()),
          )
          .map((lead) => lead.id),
      ),
    );
  }, [leads, optOutSet]);

  // ------------------------------------------------------------ sending

  const updateLeadStatus = useCallback(
    (email, status, error = null, extra = null) => {
      onLeadsChange((current) =>
        current.map((lead) =>
          lead.email?.toLowerCase() === email.toLowerCase() ? { ...lead, status, error, ...extra } : lead,
        ),
      );
    },
    [onLeadsChange],
  );

  async function startCampaign() {
    if (!canStart) return;

    setLog([]);
    setStats({ sent: 0, failed: 0, skipped: 0, total: sendableLeads.length });
    setCountdown(null);
    shouldAutoScrollRef.current = true;

    const globals = {
      product: campaign.product || '',
      reel_link: campaign.reelLink || '',
      sender_name: campaign.senderName || '',
      industry: campaign.industry || '',
      location: campaign.location || '',
    };

    const compliance = {
      postalAddress: campaign.postalAddress || '',
      unsubscribeUrl: campaign.unsubscribeUrl || '',
      unsubscribeEmail: smtp.user || '',
      appendFooter: campaign.appendFooter !== false,
    };

    // Encode the attachments once, up front, rather than per recipient: a
    // campaign sends the same files to everyone, and base64-ing a 3 MB PDF for
    // each of 200 leads would be 200 pointless reads.
    //
    // Files above the per-message ceiling are dropped here rather than failing
    // the send — the library deliberately holds files too big to attach, and
    // the Files tab already labels which ones those are.
    let encodedAttachments = [];
    try {
      encodedAttachments = await encodeAttachments(attachments);
    } catch (error) {
      appendLog({ level: 'error', message: `Could not read the attachments: ${error.message}` });
      return;
    }

    // Mark the whole selection as queued up front so the table reflects intent.
    for (const lead of sendableLeads) updateLeadStatus(lead.email, 'queued');

    const queue = createSendQueue({
      items: sendableLeads,
      minDelaySeconds: campaign.minDelay,
      maxDelaySeconds: campaign.maxDelay,
      dailyRemaining,
      maxRetries: 1,

      sendFn: async (lead) => {
        const rendered = renderEmail(selectedTemplate, lead, globals);

        if (campaign.dryRun) {
          // Exercise the full render path without touching SMTP, so a dry run
          // still catches an empty subject or a broken placeholder.
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (!rendered.subject.trim()) throw Object.assign(new Error('Rendered subject is empty.'), { retryable: false });
          return { dryRun: true, subject: rendered.subject };
        }

        const response = await fetch('/api/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: lead.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.body,
            attachments: encodedAttachments,
            credentials: smtp.user && smtp.pass ? smtp : {},
            compliance,
            meta: { templateId: selectedTemplate.id, templateName: selectedTemplate.name },
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
          throw Object.assign(new Error(data.error || `Request failed (${response.status})`), {
            // The API tells us whether another attempt could plausibly succeed.
            retryable: data.retryable === true,
            // …and whether this was a refusal rather than a failure, so the
            // queue can count an opt-out as skipped instead of broken.
            kind: data.kind || null,
            skipped: data.skipped === true,
          });
        }

        // Carried through so the "already contacted" record can show what was
        // actually sent, not just that something was.
        return { ...data, subject: rendered.subject };
      },

      onEvent: (event) => {
        setQueueState(event.state);

        if (event.type === 'countdown') {
          setCountdown(event.secondsLeft);
          return; // Never logged — it would flood the panel.
        }

        if (event.type !== 'waiting') setCountdown(null);

        setStats({ sent: event.sent, failed: event.failed, skipped: event.skipped, total: event.total });

        if (event.type === 'sending') updateLeadStatus(event.item.email, 'sending');
        if (event.type === 'sent') {
          // Timestamp and subject are recorded on the lead itself so the
          // "already contacted" list survives a reload — the run log does not.
          updateLeadStatus(event.item.email, 'sent', null, {
            sentAt: Date.now(),
            sentSubject: event.result?.subject || '',
            dryRun: Boolean(campaign.dryRun),
          });
          if (!campaign.dryRun) onRecordSend(1);
        }
        if (event.type === 'failed') updateLeadStatus(event.item.email, 'failed', event.error?.message || 'Send failed');
        if (event.type === 'skipped') {
          updateLeadStatus(event.item.email, 'unsubscribed');
          // Persist it locally too, so this device stops offering them next time.
          onOptOut?.(event.item.email);
        }
        if (event.type === 'limit-reached') {
          onLeadsChange((current) =>
            current.map((lead) => (lead.status === 'queued' ? { ...lead, status: 'skipped' } : lead)),
          );
        }

        if (event.message) {
          appendLog({
            level: event.level || 'info',
            message: event.message,
            timestamp: event.timestamp,
            progress: event.total ? `${event.sent + event.failed}/${event.total}` : null,
          });
        }
      },
    });

    queueRef.current = queue;
    await queue.start();
    queueRef.current = null;
  }

  // Warn before a reload discards an in-flight campaign.
  useEffect(() => {
    if (!isRunning) return undefined;

    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRunning]);

  const progressPercent = stats.total ? Math.round(((stats.sent + stats.failed) / stats.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      {/* ------------------------------------------------- campaign setup */}
      <Card title="Campaign setup" description="These values fill the placeholders in your template.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Template"
            value={campaign.templateId || ''}
            onChange={(event) => onCampaignChange({ ...campaign, templateId: event.target.value })}
            disabled={isRunning}
            hint={selectedTemplate ? `Subject: ${selectedTemplate.subject || '(none)'}` : 'Create one in the Templates tab.'}
          >
            <option value="">— choose a template —</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </SelectField>

          <TextField
            label="Your name"
            value={campaign.senderName || ''}
            onChange={(event) => onCampaignChange({ ...campaign, senderName: event.target.value })}
            placeholder="Martyn"
            disabled={isRunning}
            hint="Fills {{sender_name}}."
          />

          <TextField
            label="What you're offering"
            value={campaign.product || ''}
            onChange={(event) => onCampaignChange({ ...campaign, product: event.target.value })}
            placeholder="short-form video editing"
            disabled={isRunning}
            hint="Fills {{product}}."
          />
        </div>

        <div className="mt-4 grid gap-4 border-t border-edge pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label="Min delay (seconds)"
            type="number"
            min={3}
            value={campaign.minDelay}
            onChange={(event) => onCampaignChange({ ...campaign, minDelay: Math.max(3, Number(event.target.value) || 3) })}
            disabled={isRunning}
          />
          <TextField
            label="Max delay (seconds)"
            type="number"
            min={3}
            value={campaign.maxDelay}
            onChange={(event) =>
              onCampaignChange({
                ...campaign,
                maxDelay: Math.max(Number(campaign.minDelay) || 3, Number(event.target.value) || 3),
              })
            }
            disabled={isRunning}
            hint="Randomised within the range."
          />

          <div className="flex items-center lg:col-span-2">
            <Toggle
              checked={Boolean(campaign.dryRun)}
              onChange={(value) => onCampaignChange({ ...campaign, dryRun: value })}
              disabled={isRunning}
              label="Dry run"
              hint="Runs the whole pipeline and renders every message, but sends nothing. Always worth doing first."
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg border border-edge bg-surface-sunken/60 px-4 py-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <Gauge size={13} />
            {sendableLeads.length} recipient{sendableLeads.length === 1 ? '' : 's'} selected
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <Clock size={13} />
            about {estimate.label} to run
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <Activity size={13} />
            {dailyRemaining} of {GMAIL_DAILY_LIMIT} sends left today
          </span>
          {campaign.dryRun && <Badge tone="warn">dry run — nothing will be sent</Badge>}
        </div>
      </Card>

      {/* ------------------------------------------------------- pre-flight */}
      {issues.length > 0 && !isRunning && (
        <div className="flex flex-col gap-2">
          {issues.map((issue, index) => (
            <Alert key={index} tone={issue.level === 'error' ? 'error' : issue.level === 'info' ? 'info' : 'warn'}>
              {issue.text}
            </Alert>
          ))}
        </div>
      )}

      {/* --------------------------------------------------------- controls */}
      <Card
        title="Execution"
        actions={
          <>
            {!isRunning ? (
              <button type="button" onClick={startCampaign} disabled={!canStart} className="btn-primary">
                {campaign.dryRun ? <TestTube2 size={15} /> : <Rocket size={15} />}
                {campaign.dryRun ? 'Start dry run' : `Send to ${sendableLeads.length}`}
              </button>
            ) : (
              <>
                {queueState === 'running' ? (
                  <button type="button" onClick={() => queueRef.current?.pause()} className="btn-secondary">
                    <Pause size={15} />
                    Pause
                  </button>
                ) : (
                  <button type="button" onClick={() => queueRef.current?.resume()} className="btn-primary">
                    <Play size={15} />
                    Resume
                  </button>
                )}
                <button type="button" onClick={() => queueRef.current?.stop()} className="btn-danger">
                  <Square size={15} />
                  Stop
                </button>
              </>
            )}
          </>
        }
      >
        {/* Progress */}
        {(isRunning || stats.total > 0) && (
          <div className="mb-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-emerald-400">
                  <CheckCircle2 size={13} />
                  {stats.sent} sent
                </span>
                {stats.failed > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-red-400">
                    <XCircle size={13} />
                    {stats.failed} failed
                  </span>
                )}
                {stats.skipped > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-slate-500">
                    <CircleSlash size={13} />
                    {stats.skipped} skipped
                  </span>
                )}
                <span className="text-slate-500">
                  {stats.sent + stats.failed} / {stats.total}
                </span>
              </div>

              {countdown !== null && countdown > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-500/15 px-2 py-1 font-medium tabular-nums text-brand-300 animate-pulse-ring">
                  <Clock size={12} />
                  next in {countdown}s
                </span>
              )}

              {queueState === 'paused' && <Badge tone="warn">paused</Badge>}
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  stats.failed > 0 ? 'bg-gradient-to-r from-brand-500 to-amber-500' : 'bg-brand-500'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Live log */}
        <div
          onScroll={(event) => {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
            shouldAutoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
          }}
          className="h-64 overflow-y-auto rounded-lg border border-edge bg-void p-3 font-mono text-xs"
        >
          {log.length === 0 ? (
            <p className="flex h-full items-center justify-center text-slate-600">
              The execution log will appear here once the campaign starts.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {log.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 animate-fade-in">
                  <span className="shrink-0 text-slate-600">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}
                  </span>
                  {entry.progress && <span className="shrink-0 text-slate-600">[{entry.progress}]</span>}
                  <span className={LOG_TONES[entry.level] || 'text-slate-300'}>{entry.message}</span>
                </li>
              ))}
              <li ref={logEndRef} />
            </ul>
          )}
        </div>

        {log.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  log.map((entry) => ({
                    time: new Date(entry.timestamp).toISOString(),
                    level: entry.level,
                    message: entry.message,
                  })),
                  `campaign-log-${new Date().toISOString().slice(0, 10)}`,
                )
              }
              className="btn-secondary btn-sm"
            >
              <Download size={13} />
              Export log
            </button>
            <button type="button" onClick={() => setLog([])} disabled={isRunning} className="btn-ghost btn-sm">
              <Trash2 size={13} />
              Clear
            </button>

            {!isRunning && stats.failed > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(leads.filter((lead) => lead.status === 'failed').map((l) => l.id)))}
                className="btn-secondary btn-sm ml-auto"
              >
                <AlertCircle size={13} />
                Select the {stats.failed} that failed
              </button>
            )}
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- recipients */}
      <Card
        title={`To send${pending.length ? ` — ${pending.length}` : ''}`}
        description="Only leads with an e-mail address can be selected."
        actions={
          <>
            <button type="button" onClick={selectUncontacted} disabled={isRunning} className="btn-secondary btn-sm">
              Select uncontacted
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              disabled={isRunning || selectedIds.size === 0}
              className="btn-ghost btn-sm"
            >
              Clear selection
            </button>
          </>
        }
      >
        <LeadTable
          leads={pending}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onUpdateLead={(id, patch) => onLeadsChange((current) => current.map((lead) => (lead.id === id ? { ...lead, ...patch } : lead)))}
          disabled={isRunning}
          emptyTitle={contacted.length ? 'Everyone has been contacted' : 'No leads to send to'}
          emptyHint={
            contacted.length
              ? 'Every lead with an address has already been mailed. Find more in the Find leads tab.'
              : 'Head to the Lead Finder tab and scrape some sites first.'
          }
        />
      </Card>

      {/* ------------------------------------------------------------- sent */}
      {/* A separate block rather than a status column, so "who have I already
          written to" is answerable at a glance instead of by scanning. A lead
          moves down here the moment it is delivered and stops appearing above,
          which is also what stops anyone being mailed twice by accident. */}
      {contacted.length > 0 && (
        <Card
          title={`Already contacted — ${contacted.length}`}
          description="Delivered messages. These are excluded from the list above."
          actions={
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() =>
                downloadCsv(
                  contacted.map((lead) => ({
                    business: lead.business,
                    name: lead.name,
                    email: lead.email,
                    website: lead.website,
                    status: lead.status,
                    sentAt: lead.sentAt ? new Date(lead.sentAt).toISOString() : '',
                    subject: lead.sentSubject || '',
                  })),
                  `sent-${new Date().toISOString().slice(0, 10)}`,
                )
              }
            >
              <Download size={13} />
              Export
            </button>
          }
        >
          <ul className="flex flex-col gap-1.5">
            {contacted.map((lead) => (
              <li
                key={lead.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-surface-sunken/40 px-3 py-2"
              >
                <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">{lead.business || lead.name || lead.email}</p>
                  <p className="break-all text-[11px] text-slate-500">{lead.email}</p>
                </div>

                {lead.sentSubject && (
                  <p className="hidden min-w-0 max-w-[38%] truncate text-xs text-slate-500 sm:block" title={lead.sentSubject}>
                    {lead.sentSubject}
                  </p>
                )}

                {lead.sentAt && (
                  <time
                    dateTime={new Date(lead.sentAt).toISOString()}
                    className="shrink-0 text-[11px] tabular-nums text-slate-500"
                  >
                    {formatSentAt(lead.sentAt)}
                  </time>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** "14:32 today" beats a full timestamp for something sent minutes ago. */
function formatSentAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const isToday = date.toDateString() === new Date().toDateString();

  return isToday ? `${time} today` : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

const LOG_TONES = {
  info: 'text-slate-300',
  success: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

/**
 * Turns the stored file library into the shape `/api/send-email` expects.
 *
 * Files live as Blobs in IndexedDB and are base64-encoded only at this point,
 * because base64 is a third larger than the bytes it encodes and the library
 * is allowed to hold tens of megabytes. Anything over the per-message ceiling
 * is skipped rather than rejected — the library is meant to hold files too big
 * to attach, and the Files tab labels them "Link only" before you get here.
 */
async function encodeAttachments(attachments = []) {
  const sendable = attachments.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);

  return Promise.all(
    sendable.map(async (file) => ({
      filename: file.filename,
      contentType: file.contentType,
      // Older in-memory entries carry `content` as a data URL; new ones carry
      // a Blob. Both shapes have to work, since a session can span the change.
      content: file.blob ? await blobToBase64(file.blob) : file.content,
    })),
  );
}
