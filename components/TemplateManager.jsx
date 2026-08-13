'use client';

/**
 * components/TemplateManager.jsx  —  "My templates" (Write message tab)
 * ---------------------------------------------------------------------------
 * Full CRUD over an unlimited number of e-mail templates, organised by tags.
 *
 * The editor is a plain textarea rather than a rich-text editor by design:
 * heavily-formatted HTML is a well-known spam signal, and a message that looks
 * like it was typed by a person outperforms one that looks like a newsletter.
 * Formatting is limited to **bold**, *italic*, and auto-linked URLs.
 *
 * Placeholders are inserted at the caret and previewed live against a real
 * lead, so the user sees exactly what the recipient will get.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Eye,
  FilePlus2,
  FileText,
  Plus,
  Save,
  Search,
  Tag,
  TriangleAlert,
  Type,
  Wand2,
  X,
} from 'lucide-react';
import { Alert, Badge, Card, ConfirmButton, EmptyState, TextField } from './ui';
import { BUILT_IN_PLACEHOLDERS, extractPlaceholders, renderEmail } from '@/lib/templates';

/** A stand-in lead so the preview works before anything has been scraped. */
const SAMPLE_LEAD = {
  name: 'Sarah Jansen',
  business: 'Studio Noord',
  website: 'https://studionoord.nl',
  email: 'hello@studionoord.nl',
};

export default function TemplateManager({ templates, onTemplatesChange, campaign, sampleLead, onStartWizard }) {
  const [selectedId, setSelectedId] = useState(templates[0]?.id || null);
  const [draft, setDraft] = useState(null);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState('all');
  const [feedback, setFeedback] = useState(null);
  const bodyRef = useRef(null);
  const subjectRef = useRef(null);
  const lastFocusedRef = useRef('body');

  const selected = templates.find((template) => template.id === selectedId) || null;

  // Load the selected template into the draft whenever the selection changes.
  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
    setFeedback(null);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a valid selection when templates are added or removed elsewhere.
  useEffect(() => {
    if (templates.length && !templates.some((template) => template.id === selectedId)) {
      setSelectedId(templates[0].id);
    }
  }, [templates, selectedId]);

  const allTags = useMemo(() => {
    const tags = new Set();
    for (const template of templates) for (const tag of template.tags || []) tags.add(tag);
    return [...tags].sort();
  }, [templates]);

  const visibleTemplates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (activeTag !== 'all' && !(template.tags || []).includes(activeTag)) return false;
      if (!needle) return true;
      return [template.name, template.subject, template.body, ...(template.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [templates, query, activeTag]);

  const isDirty = useMemo(() => {
    if (!draft || !selected) return false;
    return (
      draft.name !== selected.name ||
      draft.subject !== selected.subject ||
      draft.body !== selected.body ||
      JSON.stringify(draft.tags || []) !== JSON.stringify(selected.tags || [])
    );
  }, [draft, selected]);

  const previewLead = sampleLead || SAMPLE_LEAD;

  const preview = useMemo(() => {
    if (!draft) return null;
    return renderEmail(
      draft,
      previewLead,
      {
        product: campaign?.product || '',
        reel_link: campaign?.reelLink || '',
        sender_name: campaign?.senderName || '',
        industry: campaign?.industry || '',
        location: campaign?.location || '',
      },
      // Show unresolved placeholders verbatim in the preview so gaps are obvious.
      { onMissing: 'keep' },
    );
  }, [draft, previewLead, campaign]);

  // ---------------------------------------------------------------- actions

  function createTemplate() {
    const now = Date.now();
    const template = {
      id: `tpl_${now}`,
      name: 'Untitled template',
      tags: [],
      subject: '',
      body: '',
      createdAt: now,
      updatedAt: now,
    };
    onTemplatesChange([...templates, template]);
    setSelectedId(template.id);
  }

  function duplicateTemplate(template) {
    const now = Date.now();
    const copy = {
      ...template,
      id: `tpl_${now}`,
      name: `${template.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    onTemplatesChange([...templates, copy]);
    setSelectedId(copy.id);
  }

  function saveDraft() {
    if (!draft) return;

    if (!draft.name.trim()) {
      setFeedback({ tone: 'error', message: 'Give the template a name.' });
      return;
    }
    if (!draft.subject.trim()) {
      setFeedback({ tone: 'error', message: 'A subject line is required — it decides whether the mail gets opened.' });
      return;
    }
    if (!draft.body.trim()) {
      setFeedback({ tone: 'error', message: 'The body is empty.' });
      return;
    }

    onTemplatesChange(
      templates.map((template) =>
        template.id === draft.id ? { ...draft, name: draft.name.trim(), updatedAt: Date.now() } : template,
      ),
    );
    setFeedback({ tone: 'success', message: 'Template saved.' });
  }

  function deleteTemplate(id) {
    const remaining = templates.filter((template) => template.id !== id);
    onTemplatesChange(remaining);
    setSelectedId(remaining[0]?.id || null);
  }

  /**
   * Inserts a placeholder at the caret of whichever field was last focused,
   * then restores focus. Appending at the end instead would force the user to
   * cut and paste it into position every single time.
   */
  function insertPlaceholder(key) {
    const token = `{{${key}}}`;
    const target = lastFocusedRef.current === 'subject' ? subjectRef.current : bodyRef.current;
    const field = lastFocusedRef.current === 'subject' ? 'subject' : 'body';

    if (!target) {
      setDraft((current) => ({ ...current, [field]: `${current[field] || ''}${token}` }));
      return;
    }

    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const next = target.value.slice(0, start) + token + target.value.slice(end);

    setDraft((current) => ({ ...current, [field]: next }));

    // Restore the caret after React has re-rendered with the new value.
    requestAnimationFrame(() => {
      target.focus();
      const caret = start + token.length;
      target.setSelectionRange(caret, caret);
    });
  }

  function addTag(rawTag) {
    const tag = rawTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag) return;
    setDraft((current) => ({
      ...current,
      tags: (current.tags || []).includes(tag) ? current.tags : [...(current.tags || []), tag],
    }));
  }

  // Unknown placeholders resolve to a fallback or to nothing — worth flagging.
  const unknownPlaceholders = useMemo(() => {
    if (!draft) return [];
    const known = new Set(BUILT_IN_PLACEHOLDERS.map((placeholder) => placeholder.key));
    return extractPlaceholders(draft.subject, draft.body).filter((key) => !known.has(key));
  }, [draft]);

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      {/* ------------------------------------------------------------ list */}
      <Card
        title={`Templates (${templates.length})`}
        actions={
          <>
            {/* The wizard used to be a tab of its own, which meant a fresh
                install opened on a five-question form before showing a single
                template. It lives here now — reachable at the moment someone
                actually decides they want a new one. */}
            {onStartWizard && (
              <button
                type="button"
                onClick={onStartWizard}
                className="btn-secondary btn-sm"
                title="Answer a few questions and get a finished template"
              >
                <Wand2 size={13} />
                Write for me
              </button>
            )}
            <button type="button" onClick={createTemplate} className="btn-primary btn-sm" title="Create a new template">
              <Plus size={13} />
              New
            </button>
          </>
        }
        className="h-fit lg:sticky lg:top-[104px]"
      >
        <div className="relative mb-3">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search templates…"
            className="input py-1.5 pl-8 text-xs"
            aria-label="Search templates"
          />
        </div>

        {allTags.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1">
            <TagPill active={activeTag === 'all'} onClick={() => setActiveTag('all')}>
              all
            </TagPill>
            {allTags.map((tag) => (
              <TagPill key={tag} active={activeTag === tag} onClick={() => setActiveTag(tag)}>
                {tag}
              </TagPill>
            ))}
          </div>
        )}

        {visibleTemplates.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">
            {templates.length ? 'Nothing matches that filter.' : 'No templates yet.'}
          </p>
        ) : (
          <ul className="flex max-h-[440px] flex-col gap-1 overflow-y-auto pr-1">
            {visibleTemplates.map((template) => {
              const isActive = template.id === selectedId;
              return (
                <li key={template.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(template.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      isActive
                        ? 'border-brand-500/50 bg-brand-500/10'
                        : 'border-transparent hover:border-edge-strong hover:bg-white/[0.06]'
                    }`}
                  >
                    <span
                      className={`block truncate text-sm font-medium ${isActive ? 'text-brand-200' : 'text-slate-200'}`}
                    >
                      {template.name || 'Untitled'}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                      {template.subject || 'No subject'}
                    </span>
                    {(template.tags || []).length > 0 && (
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {template.tags.map((tag) => (
                          <span key={tag} className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-slate-400">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ---------------------------------------------------------- editor */}
      {!draft ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="No template selected"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {onStartWizard && (
                  <button type="button" onClick={onStartWizard} className="btn-primary btn-sm">
                    <Wand2 size={14} />
                    Write one for me
                  </button>
                )}
                <button
                  type="button"
                  onClick={createTemplate}
                  className={onStartWizard ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                >
                  <FilePlus2 size={14} />
                  Start from blank
                </button>
              </div>
            }
          >
            Templates support placeholders like <code className="text-brand-300">{'{{name}}'}</code> and{' '}
            <code className="text-brand-300">{'{{business}}'}</code>, filled per recipient at send time.
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <Card
            title="Edit template"
            description={selected?.updatedAt ? `Last saved ${new Date(selected.updatedAt).toLocaleString()}` : undefined}
            actions={
              <>
                {isDirty && <Badge tone="warn">Unsaved</Badge>}
                <button
                  type="button"
                  onClick={() => duplicateTemplate(selected)}
                  className="btn-secondary btn-sm"
                  title="Duplicate this template"
                >
                  <Copy size={13} />
                  Duplicate
                </button>
                <ConfirmButton onConfirm={() => deleteTemplate(draft.id)} title="Delete this template">
                  <X size={13} />
                  Delete
                </ConfirmButton>
                <button type="button" onClick={saveDraft} disabled={!isDirty} className="btn-primary btn-sm">
                  <Save size={13} />
                  Save
                </button>
              </>
            }
          >
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Template name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="e.g. Video editor → local business"
                  required
                />

                <div>
                  <label className="label">Tags</label>
                  <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-edge bg-surface-sunken p-2">
                    {(draft.tags || []).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded bg-white/[0.08] px-2 py-0.5 text-xs text-slate-300"
                      >
                        <Tag size={9} />
                        {tag}
                        <button
                          type="button"
                          onClick={() => setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) })}
                          className="text-slate-500 transition-colors hover:text-red-400"
                          aria-label={`Remove tag ${tag}`}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      placeholder={draft.tags?.length ? 'add…' : 'intro, follow-up, video…'}
                      className="min-w-[90px] flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                          event.preventDefault();
                          addTag(event.currentTarget.value);
                          event.currentTarget.value = '';
                        }
                      }}
                      onBlur={(event) => {
                        addTag(event.target.value);
                        event.target.value = '';
                      }}
                      aria-label="Add a tag"
                    />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Press Enter or comma to add.</p>
                </div>
              </div>

              {/* Written out rather than using <TextField> because the caret
                  position is needed for placeholder insertion, which requires
                  a ref on the input itself. */}
              <div>
                <label className="label" htmlFor="template-subject">
                  Subject line <span className="text-brand-400">*</span>
                </label>
                <input
                  id="template-subject"
                  ref={subjectRef}
                  type="text"
                  value={draft.subject}
                  onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                  onFocus={() => { lastFocusedRef.current = 'subject'; }}
                  placeholder="Quick idea for {{business}}"
                  className="input"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Short, specific and lower-case tends to out-open anything that reads like marketing.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="template-body">
                  Message body <span className="text-brand-400">*</span>
                </label>
                <textarea
                  id="template-body"
                  ref={bodyRef}
                  value={draft.body}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                  onFocus={() => { lastFocusedRef.current = 'body'; }}
                  rows={14}
                  className="input resize-y font-mono text-[13px] leading-relaxed"
                  placeholder={'Hi {{first_name|there}},\n\nI came across {{business}} and…'}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Plain text with <code className="text-slate-400">**bold**</code>,{' '}
                  <code className="text-slate-400">*italic*</code>, and auto-linked URLs. Blank lines become paragraphs.
                </p>
              </div>

              {/* Placeholder palette */}
              <div className="rounded-lg border border-edge bg-surface-sunken/60 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-300">
                  <Type size={12} />
                  Insert a placeholder at the cursor
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {BUILT_IN_PLACEHOLDERS.map((placeholder) => (
                    <button
                      key={placeholder.key}
                      type="button"
                      onClick={() => insertPlaceholder(placeholder.key)}
                      title={`${placeholder.label} — e.g. "${placeholder.example}"`}
                      className="chip"
                    >
                      {`{{${placeholder.key}}}`}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Invent your own too — any <code className="text-brand-300">{'{{key}}'}</code> resolves from a lead&apos;s
                  custom fields. Add a fallback with a pipe:{' '}
                  <code className="text-brand-300">{'{{name|there}}'}</code> renders &ldquo;there&rdquo; when the name is
                  unknown.
                </p>
              </div>

              {unknownPlaceholders.length > 0 && (
                <Alert tone="warn" title="Custom placeholders in use">
                  <span className="font-mono">{unknownPlaceholders.map((key) => `{{${key}}}`).join(', ')}</span> — these
                  are not built in, so they resolve from each lead&apos;s custom fields. Give them a fallback (
                  <code>{'{{key|default}}'}</code>) or they will render as nothing.
                </Alert>
              )}

              {feedback && (
                <Alert tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                  {feedback.message}
                </Alert>
              )}
            </div>
          </Card>

          {/* --------------------------------------------------------- preview */}
          <Card
            title="Live preview"
            description={`Rendered against ${sampleLead ? `${previewLead.business || previewLead.email}` : 'a sample lead'}`}
            actions={
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <Eye size={12} />
                Updates as you type
              </span>
            }
          >
            <div className="overflow-hidden rounded-lg border border-edge bg-white">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Subject</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">
                  {preview?.subject || <span className="italic text-slate-400">No subject</span>}
                </p>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  To: {previewLead.email || 'recipient@example.com'}
                </p>
              </div>
              <div
                className="px-4 py-4"
                // The preview renders our own generated HTML from the user's
                // own template — same content their recipient receives.
                dangerouslySetInnerHTML={{ __html: preview?.html || '' }}
              />
            </div>

            {preview?.missing?.length > 0 && (
              <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-400">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                <span>
                  Unresolved for this lead:{' '}
                  <span className="font-mono">{preview.missing.map((key) => `{{${key}}}`).join(', ')}</span>. Fill them
                  in on the Campaign tab, or add a fallback so the message never ships with a gap.
                </span>
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function TagPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active ? 'bg-brand-500/20 text-brand-300' : 'bg-white/[0.08] text-slate-400 hover:bg-white/[0.12] hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}
