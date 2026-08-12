'use client';

/**
 * components/DeliverabilityPanel.jsx
 * ---------------------------------------------------------------------------
 * "Why is my mail going to spam?" — answered with a DNS audit of the sending
 * domain plus a content scan of the selected template.
 *
 * The DNS half is usually the real answer. Cold e-mail from an unauthenticated
 * domain (or a free @gmail.com mailbox) gets filtered no matter how well the
 * message is written, so that result is shown first and largest.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  Info,
  Radar,
  ShieldCheck,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Alert, Badge, Card, Spinner } from './ui';

const SEVERITY_STYLE = {
  high: { tone: 'error', Icon: XCircle, label: 'Fix this' },
  medium: { tone: 'warn', Icon: AlertTriangle, label: 'Worth fixing' },
  low: { tone: 'neutral', Icon: Info, label: 'Minor' },
  ok: { tone: 'success', Icon: CheckCircle2, label: 'Good' },
  unknown: { tone: 'neutral', Icon: HelpCircle, label: 'Unknown' },
};

const GRADE_STYLE = {
  excellent: { tone: 'success', label: 'Clean' },
  good: { tone: 'success', label: 'Good' },
  risky: { tone: 'warn', label: 'Risky' },
  poor: { tone: 'error', label: 'Likely to be filtered' },
};

export default function DeliverabilityPanel({ smtp, serverStatus, campaign, templates, attachments = [] }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showPlaybook, setShowPlaybook] = useState(false);

  const senderEmail = smtp?.user || serverStatus?.smtpUser || '';
  const template = templates?.find((entry) => entry.id === campaign?.templateId) || templates?.[0] || null;

  async function runCheck() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/deliverability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: senderEmail,
          subject: template?.subject || '',
          body: template?.body || '',
          attachmentCount: attachments.length,
          hasUnsubscribe: campaign?.appendFooter !== false,
          hasPostalAddress: Boolean(campaign?.postalAddress || serverStatus?.postalAddress),
        }),
      });

      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Check failed.');
      setResult(data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  const verdictTone =
    result?.dns?.verdict.level === 'ok' ? 'success' : result?.dns?.verdict.level === 'warn' ? 'warn' : 'error';

  return (
    <Card
      title="Deliverability check"
      description="Why your mail lands in spam — and what actually fixes it."
      actions={
        <button type="button" onClick={runCheck} disabled={loading || !senderEmail} className="btn-primary btn-sm">
          {loading ? <Spinner size={13} /> : <Radar size={13} />}
          {result ? 'Re-check' : 'Run check'}
        </button>
      }
    >
      {!senderEmail && (
        <Alert tone="info">Add your sending address above, then run the check.</Alert>
      )}

      {error && (
        <Alert tone="error" className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!result && senderEmail && !loading && (
        <p className="text-sm leading-relaxed text-slate-400">
          This looks up whether <strong className="text-slate-300">{senderEmail.split('@')[1]}</strong> publishes SPF,
          DKIM and DMARC records, and scans{' '}
          {template ? <>your &ldquo;{template.name}&rdquo; template</> : 'your template'} for the phrasing and link
          patterns that trip spam filters.
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-5">
          {/* -------------------------------------------------- DNS verdict */}
          {result.dns && (
            <div>
              <div
                className={`flex items-start gap-3 rounded-xl border p-4 ${
                  verdictTone === 'success'
                    ? 'border-mint-400/25 bg-mint-500/[0.08]'
                    : verdictTone === 'warn'
                      ? 'border-amber-400/25 bg-amber-500/[0.08]'
                      : 'border-red-400/25 bg-red-500/[0.08]'
                }`}
              >
                {verdictTone === 'success' ? (
                  <ShieldCheck size={20} className="mt-0.5 shrink-0 text-mint-400" />
                ) : (
                  <ShieldAlert
                    size={20}
                    className={`mt-0.5 shrink-0 ${verdictTone === 'warn' ? 'text-amber-400' : 'text-red-400'}`}
                  />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-100">{result.dns.verdict.headline}</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{result.dns.verdict.detail}</p>
                </div>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <RecordRow name="SPF" data={result.dns.spf} />
                <RecordRow name="DKIM" data={result.dns.dkim} />
                <RecordRow name="DMARC" data={result.dns.dmarc} />
                <RecordRow
                  name="MX"
                  data={{
                    ok: result.dns.mx.ok,
                    severity: result.dns.mx.ok ? 'ok' : 'high',
                    summary: result.dns.mx.summary,
                    detail: result.dns.mx.records.join(', '),
                  }}
                />
              </div>
            </div>
          )}

          {result.dnsError && <Alert tone="warn">Could not check DNS: {result.dnsError}</Alert>}

          {/* ------------------------------------------------ content scan */}
          {result.content && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-semibold text-slate-100">Message content</h3>
                <Badge tone={GRADE_STYLE[result.content.grade]?.tone || 'neutral'}>
                  {GRADE_STYLE[result.content.grade]?.label || result.content.grade}
                </Badge>
                <span className="text-xs text-slate-500">
                  {result.content.stats.words} words · {result.content.stats.links} link
                  {result.content.stats.links === 1 ? '' : 's'} · subject {result.content.stats.subjectLength} chars
                </span>
              </div>

              {result.content.findings.length === 0 ? (
                <Alert tone="success">Nothing in the message itself looks likely to trip a filter.</Alert>
              ) : (
                <ul className="flex flex-col gap-2">
                  {result.content.findings.map((finding, index) => {
                    const style = SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.low;
                    const Icon = style.Icon;

                    return (
                      <li
                        key={index}
                        className="flex items-start gap-2.5 rounded-xl border border-edge bg-white/[0.02] p-3"
                      >
                        <Icon
                          size={15}
                          className={`mt-0.5 shrink-0 ${
                            finding.severity === 'high'
                              ? 'text-red-400'
                              : finding.severity === 'medium'
                                ? 'text-amber-400'
                                : 'text-slate-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <p className="text-sm text-slate-200">{finding.title}</p>
                          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{finding.detail}</p>
                          {finding.fix && (
                            <p className="mt-1 text-xs leading-relaxed text-brand-300">→ {finding.fix}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* --------------------------------------------------- playbook */}
          <div className="rounded-xl border border-edge bg-white/[0.02]">
            <button
              type="button"
              onClick={() => setShowPlaybook((value) => !value)}
              aria-expanded={showPlaybook}
              className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
            >
              <ShieldCheck size={15} className="shrink-0 text-brand-400" />
              <span className="flex-1 text-sm font-medium text-slate-200">
                What actually keeps mail out of spam
              </span>
              <ChevronDown
                size={15}
                className={`shrink-0 text-slate-500 transition-transform ${showPlaybook ? 'rotate-180' : ''}`}
              />
            </button>

            {showPlaybook && (
              <ul className="flex flex-col gap-3 border-t border-edge-soft p-4">
                {result.playbook.map((entry) => (
                  <li key={entry.title} className="flex items-start gap-2.5">
                    <Badge tone={entry.impact === 'huge' ? 'error' : entry.impact === 'high' ? 'warn' : 'neutral'}>
                      {entry.impact}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200">{entry.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{entry.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            No tool can guarantee inbox placement — filtering is driven mostly by sender reputation, which is built
            over weeks of people wanting your mail. This check covers the part you control.
          </p>
        </div>
      )}
    </Card>
  );
}

/** One DNS record result. */
function RecordRow({ name, data }) {
  const [open, setOpen] = useState(false);
  const severity = data.severity || (data.ok ? 'ok' : 'high');
  const style = SEVERITY_STYLE[severity] || SEVERITY_STYLE.low;
  const Icon = style.Icon;

  return (
    <div className="rounded-xl border border-edge bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <Icon
          size={15}
          className={`shrink-0 ${
            severity === 'ok'
              ? 'text-mint-400'
              : severity === 'high'
                ? 'text-red-400'
                : severity === 'medium'
                  ? 'text-amber-400'
                  : severity === 'unknown'
                    ? 'text-slate-400'
                    : 'text-slate-500'
          }`}
        />
        <span className="w-12 shrink-0 font-mono text-xs font-semibold text-slate-300">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{data.summary}</span>
        <ChevronDown size={13} className={`shrink-0 text-slate-600 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-edge-soft px-3 py-2.5">
          {data.detail && <p className="text-xs leading-relaxed text-slate-400">{data.detail}</p>}
          {data.record && (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-void/60 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
              {data.record}
            </pre>
          )}
          {data.fix && <p className="mt-2 text-xs leading-relaxed text-brand-300">→ {data.fix}</p>}
        </div>
      )}
    </div>
  );
}
