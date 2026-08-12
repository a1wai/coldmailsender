'use client';

/**
 * components/ui.jsx
 * ---------------------------------------------------------------------------
 * Small shared presentational primitives. Keeping them here stops the five tab
 * components from each re-inventing a card, a labelled field, and an alert.
 *
 * The visual language lives in `app/globals.css` (`.card`, `.input`, `.btn-*`);
 * these components mostly handle structure and accessibility wiring.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Info, Loader2, X, XCircle } from 'lucide-react';

export function Card({ title, description, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-400">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

/** A labelled form control. Wires up `htmlFor`/`id` and hint/error text. */
export function Field({ label, hint, error, required, children, className = '' }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {required && <span className="ml-1 text-brand-400">*</span>}
      </label>

      {typeof children === 'function'
        ? children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })
        : children}

      {error ? (
        <p id={`${id}-error`} className="mt-1 flex items-start gap-1 text-xs text-red-400">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Convenience wrapper: `<Field>` plus a text input, the most common pairing. */
export function TextField({ label, hint, error, required, className, ...inputProps }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(a11y) => <input {...a11y} className="input" {...inputProps} />}
    </Field>
  );
}

export function TextAreaField({ label, hint, error, required, className, rows = 4, ...props }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(a11y) => <textarea {...a11y} rows={rows} className="input resize-y font-mono leading-relaxed" {...props} />}
    </Field>
  );
}

export function SelectField({ label, hint, error, className, children, ...props }) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(a11y) => (
        <div className="relative">
          <select {...a11y} className="input cursor-pointer appearance-none pr-9" {...props}>
            {children}
          </select>
          <ChevronDown
            size={15}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
        </div>
      )}
    </Field>
  );
}

const ALERT_STYLES = {
  info: { wrap: 'border-brand-500/30 bg-brand-500/10 text-brand-200', Icon: Info },
  success: { wrap: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200', Icon: Check },
  warn: { wrap: 'border-amber-500/30 bg-amber-500/10 text-amber-200', Icon: AlertTriangle },
  error: { wrap: 'border-red-500/30 bg-red-500/10 text-red-200', Icon: XCircle },
};

export function Alert({ tone = 'info', title, children, onDismiss, className = '' }) {
  const { wrap, Icon } = ALERT_STYLES[tone] || ALERT_STYLES.info;

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm animate-fade-in ${wrap} ${className}`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5 text-xs opacity-90' : 'text-sm'}>{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

const BADGE_TONES = {
  neutral: 'bg-ink-700 text-slate-300',
  brand: 'bg-brand-500/15 text-brand-300',
  success: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
};

export function Badge({ tone = 'neutral', children, className = '' }) {
  return <span className={`badge ${BADGE_TONES[tone] || BADGE_TONES.neutral} ${className}`}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && (
        <div className="mb-3 rounded-full border border-ink-700 bg-ink-800 p-3">
          <Icon size={22} className="text-slate-500" />
        </div>
      )}
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {children && <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 15, className = '' }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} aria-hidden="true" />;
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  const id = useId();

  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-brand-600' : 'bg-ink-600'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <label htmlFor={id} className="cursor-pointer select-none">
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}
      </label>
    </div>
  );
}

/**
 * A destructive button that requires a second click to fire, reverting after
 * three seconds. Cheaper than a modal and enough friction to prevent deleting
 * a template by accident.
 */
export function ConfirmButton({ onConfirm, children, confirmLabel = 'Sure?', className = 'btn-danger btn-sm', title }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <button
      type="button"
      title={title}
      className={className}
      onClick={() => {
        if (armed) {
          clearTimeout(timerRef.current);
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          timerRef.current = setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

/** Formats a byte count for attachment sizes. */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
