'use client';

/**
 * components/SmtpSettings.jsx  —  Tab 4 (Settings)
 * ---------------------------------------------------------------------------
 * Gmail / SMTP credentials plus the compliance fields that go in every footer.
 *
 * Security posture, stated plainly in the UI as well as here:
 *   - The app password is held in sessionStorage by default, so it is gone the
 *     moment the tab closes. "Remember on this device" opts into localStorage.
 *   - It is posted to our own API route per send and used immediately; nothing
 *     is written to a server-side store or log.
 *   - Setting SMTP_USER / SMTP_PASS as environment variables is strictly safer
 *     — the browser then never holds the secret at all — and the UI says so
 *     whenever it detects server-side credentials.
 */

import { useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  PlugZap,
  Send,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Alert, Card, SelectField, Spinner, TextField, Toggle } from './ui';

export default function SmtpSettings({
  smtp,
  onSmtpChange,
  remember,
  onRememberChange,
  campaign,
  onCampaignChange,
  serverStatus,
  onClearCredentials,
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (patch) => onSmtpChange({ ...smtp, ...patch });

  const usingServerCredentials = Boolean(serverStatus?.smtpConfigured) && !smtp.user && !smtp.pass;

  // Google shows app passwords as "abcd efgh ijkl mnop" — strip spaces before
  // counting so a correctly-pasted password is not reported as 19 characters.
  const passwordLength = (smtp.pass || '').replace(/\s+/g, '').length;
  const looksLikeGmail = /@gmail\.com$/i.test(smtp.user || '');
  const passwordWarning =
    looksLikeGmail && passwordLength > 0 && passwordLength !== 16
      ? `That is ${passwordLength} characters — a Gmail app password is exactly 16.`
      : null;

  async function testConnection(sendTestEmail) {
    setTesting(true);
    setResult(null);

    try {
      const response = await fetch('/api/test-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Send an empty object when relying on server credentials, so the
          // route falls through to the environment variables.
          credentials: usingServerCredentials ? {} : smtp,
          sendTestEmail,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        setResult({ tone: 'error', title: 'Connection failed', message: data.error || 'Unknown error.' });
      } else if (data.testEmailSent) {
        setResult({
          tone: 'success',
          title: 'Test message sent',
          message: `${data.message} Check the inbox of ${data.testEmailTo}.`,
        });
      } else if (data.testEmailError) {
        setResult({ tone: 'warn', title: 'Connected, but the test send failed', message: data.testEmailError });
      } else {
        setResult({ tone: 'success', title: 'Connection verified', message: data.message });
      }
    } catch (error) {
      setResult({ tone: 'error', title: 'Request failed', message: error.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {usingServerCredentials && (
        <Alert tone="success" title="Using server-side credentials">
          <code>SMTP_USER</code> and <code>SMTP_PASS</code> are configured in the environment
          {serverStatus.smtpUser && (
            <>
              {' '}
              (<strong>{serverStatus.smtpUser}</strong>)
            </>
          )}
          , so the browser never handles your password. Leave the fields below blank to keep it that way — anything you
          type here takes precedence.
        </Alert>
      )}

      <Card
        title="Sender identity"
        description="The account your outreach is sent from."
        actions={
          <>
            <button
              type="button"
              onClick={() => testConnection(false)}
              disabled={testing}
              className="btn-secondary btn-sm"
            >
              {testing ? <Spinner size={13} /> : <PlugZap size={13} />}
              Test connection
            </button>
            <button
              type="button"
              onClick={() => testConnection(true)}
              disabled={testing}
              className="btn-primary btn-sm"
              title="Verifies the connection and sends one message to your own address"
            >
              <Send size={13} />
              Send test to myself
            </button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Gmail address"
            type="email"
            autoComplete="username"
            value={smtp.user}
            onChange={(event) => update({ user: event.target.value })}
            placeholder={serverStatus?.smtpUser || 'you@gmail.com'}
            hint="Also used as the From and default Reply-To address."
          />

          <TextField
            label="Sender name"
            value={smtp.fromName}
            onChange={(event) => update({ fromName: event.target.value })}
            placeholder="Your Name"
            hint="Shown in the recipient's inbox. A real human name outperforms a company name."
          />
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="smtp-password">
            Gmail app password
          </label>
          <div className="relative">
            <KeyRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              id="smtp-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={smtp.pass}
              onChange={(event) => update({ pass: event.target.value })}
              placeholder="abcd efgh ijkl mnop"
              className="input pl-9 pr-10 font-mono"
              aria-describedby="smtp-password-hint"
            />
            <button
              type="button"
              onClick={() => setShowPassword((current) => !current)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-300"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          <p id="smtp-password-hint" className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
            <span>Not your account password —</span>
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-brand-400 transition-colors hover:text-brand-300"
            >
              generate a 16-character app password
              <ExternalLink size={10} />
            </a>
            <span>(requires 2-Step Verification).</span>
            {passwordLength > 0 && (
              <span className={passwordWarning ? 'text-amber-400' : 'text-emerald-400'}>
                {passwordLength} characters entered
              </span>
            )}
          </p>

          {passwordWarning && (
            <p className="mt-1 text-xs text-amber-400">{passwordWarning}</p>
          )}
        </div>

        {/* Storage choice */}
        <div className="mt-5 rounded-lg border border-ink-700 bg-ink-900/60 p-3.5">
          <Toggle
            checked={remember}
            onChange={onRememberChange}
            label="Remember on this device"
            hint={
              remember
                ? 'Stored in localStorage — it survives closing the browser. Only do this on a machine you control.'
                : 'Stored in sessionStorage — cleared automatically when you close this tab. Recommended.'
            }
          />

          {(smtp.user || smtp.pass) && (
            <button
              type="button"
              onClick={() => {
                onClearCredentials();
                setResult(null);
              }}
              className="btn-ghost btn-sm mt-3 text-red-400 hover:bg-red-950/40 hover:text-red-300"
            >
              <Trash2 size={13} />
              Clear stored credentials
            </button>
          )}
        </div>

        {result && (
          <Alert tone={result.tone} title={result.title} className="mt-4" onDismiss={() => setResult(null)}>
            {result.message}
          </Alert>
        )}

        {/* Advanced SMTP */}
        <div className="mt-5 border-t border-ink-700 pt-4">
          <button
            type="button"
            onClick={() => setShowAdvanced((current) => !current)}
            className="flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
          >
            <Server size={12} />
            {showAdvanced ? 'Hide' : 'Show'} advanced SMTP settings
          </button>

          {showAdvanced && (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <TextField
                label="SMTP host"
                value={smtp.host}
                onChange={(event) => update({ host: event.target.value })}
                placeholder="smtp.gmail.com"
              />
              <TextField
                label="Port"
                type="number"
                value={smtp.port}
                onChange={(event) => update({ port: Number(event.target.value) })}
                placeholder="465"
              />
              <SelectField
                label="Encryption"
                value={String(smtp.secure)}
                onChange={(event) => update({ secure: event.target.value === 'true' })}
              >
                <option value="true">SSL / TLS (port 465)</option>
                <option value="false">STARTTLS (port 587)</option>
              </SelectField>

              <div className="sm:col-span-3">
                <TextField
                  label="Reply-To (optional)"
                  type="email"
                  value={smtp.replyTo}
                  onChange={(event) => update({ replyTo: event.target.value })}
                  placeholder="Leave blank to use the sender address"
                  hint="Useful when you send from one address but want replies elsewhere."
                />
              </div>

              <p className="text-xs text-slate-500 sm:col-span-3">
                Any SMTP provider works here — Zoho, Brevo, Mailgun and Resend all have permanent free tiers with
                higher daily caps than Gmail.
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------ compliance */}
      <Card
        title="Compliance footer"
        description="Appended to every message. Not optional in most jurisdictions — and it improves inbox placement."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Physical postal address"
            value={campaign.postalAddress || ''}
            onChange={(event) => onCampaignChange({ ...campaign, postalAddress: event.target.value })}
            placeholder="Street 1, 3011 AB Rotterdam, NL"
            hint="Required by CAN-SPAM (US) and equivalent rules elsewhere."
          />
          <TextField
            label="Unsubscribe URL (optional)"
            type="url"
            value={campaign.unsubscribeUrl || ''}
            onChange={(event) => onCampaignChange({ ...campaign, unsubscribeUrl: event.target.value })}
            placeholder="https://yoursite.com/unsubscribe"
            hint="A form, a Notion page — anything that records the request."
          />
        </div>

        <div className="mt-4">
          <Toggle
            checked={campaign.appendFooter !== false}
            onChange={(value) => onCampaignChange({ ...campaign, appendFooter: value })}
            label="Append the compliance footer to every message"
            hint="Includes an opt-out line, your postal address, and the List-Unsubscribe header Gmail looks for."
          />
        </div>

        {campaign.appendFooter !== false && !campaign.unsubscribeUrl && (
          <Alert tone="info" className="mt-4">
            With no unsubscribe URL set, the footer asks recipients to reply with &ldquo;unsubscribe&rdquo; and the
            header points at your sending address. That is valid — just make sure you actually honour those replies.
          </Alert>
        )}

        {campaign.appendFooter === false && (
          <Alert tone="warn" className="mt-4" title="Footer disabled">
            Unsolicited commercial e-mail without a working opt-out and a postal address breaches CAN-SPAM, CASL and
            PECR. Only turn this off if your footer is already written into the template itself.
          </Alert>
        )}
      </Card>

      {/* ---------------------------------------------------- how it works */}
      <Card title="Where your password goes">
        <ul className="flex flex-col gap-2.5 text-sm text-slate-300">
          <SecurityPoint icon={ShieldCheck}>
            It is sent to this app&apos;s own API route over HTTPS, used to open one SMTP connection, and discarded.
            It is never written to a database or a log.
          </SecurityPoint>
          <SecurityPoint icon={Mail}>
            An app password only grants mail access, and you can revoke it at any time from your Google account without
            touching your real password.
          </SecurityPoint>
          <SecurityPoint icon={Server}>
            The strongest option is to set <code className="text-brand-300">SMTP_USER</code> and{' '}
            <code className="text-brand-300">SMTP_PASS</code> as environment variables in Vercel. The browser then never
            sees the secret at all.
          </SecurityPoint>
          <SecurityPoint icon={CheckCircle2}>
            This deployment is yours. Nothing is transmitted to the author of this project or to any third party beyond
            the mail provider you configure.
          </SecurityPoint>
        </ul>
      </Card>
    </div>
  );
}

function SecurityPoint({ icon: Icon, children }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon size={15} className="mt-0.5 shrink-0 text-emerald-400" />
      <span className="text-xs leading-relaxed text-slate-400">{children}</span>
    </li>
  );
}
