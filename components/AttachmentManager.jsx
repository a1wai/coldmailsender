'use client';

/**
 * components/AttachmentManager.jsx  —  Tab 3
 * ---------------------------------------------------------------------------
 * Two related jobs:
 *
 *   1. Drag-and-drop file attachments, held in memory as base64 and posted
 *      with each send. Deliberately NOT persisted to LocalStorage — base64
 *      blows through the ~5 MB quota and would evict the leads and templates
 *      that actually matter. Re-attach after a page reload.
 *
 *   2. A library of portfolio / reel links, one of which is marked active and
 *      fills `{{reel_link}}` in every template. Swapping which reel a campaign
 *      points at is then a single click rather than an edit to every template.
 *
 * A note the UI makes explicitly: attachments hurt cold-email deliverability.
 * A link almost always lands better than a 2 MB PDF.
 */

import { useCallback, useRef, useState } from 'react';
import {
  CheckCircle2,
  Film,
  Link as LinkIcon,
  Paperclip,
  Plus,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { Alert, Badge, Card, EmptyState, formatBytes } from './ui';
import { readFileAsDataUrl } from '@/lib/storage';
import { MAX_ATTACHMENT_BYTES } from '@/lib/constants';

export default function AttachmentManager({ attachments, onAttachmentsChange, reelLinks, onReelLinksChange, campaign, onCampaignChange }) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState(null);
  const [newLink, setNewLink] = useState({ label: '', url: '' });
  const dragCounter = useRef(0);

  const totalBytes = attachments.reduce((sum, file) => sum + file.size, 0);
  const percentUsed = Math.min(100, Math.round((totalBytes / MAX_ATTACHMENT_BYTES) * 100));

  const addFiles = useCallback(
    async (fileList) => {
      setError(null);
      const incoming = [...fileList];
      if (!incoming.length) return;

      let runningTotal = totalBytes;
      const accepted = [];
      const rejected = [];

      for (const file of incoming) {
        if (runningTotal + file.size > MAX_ATTACHMENT_BYTES) {
          rejected.push(`${file.name} (${formatBytes(file.size)})`);
          continue;
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          const dataUrl = await readFileAsDataUrl(file);
          accepted.push({
            id: `att_${Date.now()}_${accepted.length}`,
            filename: file.name,
            size: file.size,
            contentType: file.type || 'application/octet-stream',
            content: dataUrl,
          });
          runningTotal += file.size;
        } catch (readError) {
          rejected.push(`${file.name} (${readError.message})`);
        }
      }

      if (accepted.length) onAttachmentsChange([...attachments, ...accepted]);

      if (rejected.length) {
        setError(
          `Could not attach ${rejected.join(', ')}. The total budget is ${formatBytes(MAX_ATTACHMENT_BYTES)} — ` +
            'host anything bigger and send a link instead.',
        );
      }
    },
    [attachments, onAttachmentsChange, totalBytes],
  );

  function handleDrop(event) {
    event.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
  }

  function addReelLink() {
    const url = newLink.url.trim();
    if (!url) return;

    let normalized = url;
    try {
      normalized = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).toString();
    } catch {
      setError(`"${url}" is not a valid URL.`);
      return;
    }

    const link = {
      id: `reel_${Date.now()}`,
      label: newLink.label.trim() || guessLabel(normalized),
      url: normalized,
    };

    const next = [...reelLinks, link];
    onReelLinksChange(next);

    // First link added becomes the active one automatically.
    if (!campaign.reelLinkId) onCampaignChange({ ...campaign, reelLinkId: link.id, reelLink: link.url });

    setNewLink({ label: '', url: '' });
    setError(null);
  }

  function setActiveReel(link) {
    onCampaignChange({ ...campaign, reelLinkId: link.id, reelLink: link.url });
  }

  function removeReel(id) {
    const next = reelLinks.filter((link) => link.id !== id);
    onReelLinksChange(next);

    if (campaign.reelLinkId === id) {
      const fallback = next[0];
      onCampaignChange({
        ...campaign,
        reelLinkId: fallback?.id || '',
        reelLink: fallback?.url || '',
      });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ------------------------------------------------------ reel links */}
      <Card
        title="Portfolio & reel links"
        description="The active link fills {{reel_link}} in every template. Swap it here instead of editing each one."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={newLink.label}
            onChange={(event) => setNewLink({ ...newLink, label: event.target.value })}
            placeholder="Label (e.g. Restaurant reel)"
            className="input sm:w-56"
            aria-label="Link label"
          />
          <input
            type="url"
            value={newLink.url}
            onChange={(event) => setNewLink({ ...newLink, url: event.target.value })}
            onKeyDown={(event) => event.key === 'Enter' && addReelLink()}
            placeholder="https://youtube.com/watch?v=…"
            className="input flex-1"
            aria-label="Link URL"
          />
          <button type="button" onClick={addReelLink} disabled={!newLink.url.trim()} className="btn-primary">
            <Plus size={14} />
            Add
          </button>
        </div>

        {reelLinks.length === 0 ? (
          <div className="mt-4">
            <EmptyState icon={Film} title="No links yet">
              Add a YouTube, Vimeo, Drive or portfolio URL. Linking to hosted work beats attaching a file — it keeps the
              message light and lets you see the click.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {reelLinks.map((link) => {
              const isActive = campaign.reelLinkId === link.id;
              return (
                <li
                  key={link.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                    isActive ? 'border-brand-500/50 bg-brand-500/[0.08]' : 'border-ink-700 bg-ink-900/50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveReel(link)}
                    title={isActive ? 'Active link' : 'Make this the active link'}
                    className={`shrink-0 transition-colors ${
                      isActive ? 'text-brand-400' : 'text-slate-600 hover:text-slate-400'
                    }`}
                    aria-label={isActive ? 'Active link' : `Set ${link.label} as active`}
                  >
                    <Star size={15} fill={isActive ? 'currentColor' : 'none'} />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-200">{link.label}</span>
                      {isActive && <Badge tone="brand">active</Badge>}
                    </div>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-xs text-slate-500 transition-colors hover:text-brand-400"
                    >
                      {link.url}
                    </a>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeReel(link.id)}
                    className="shrink-0 rounded p-1.5 text-slate-600 transition-colors hover:bg-red-950/50 hover:text-red-400"
                    aria-label={`Remove ${link.label}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {campaign.reelLink && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
            <LinkIcon size={11} />
            <code className="text-brand-300">{'{{reel_link}}'}</code> currently resolves to{' '}
            <span className="truncate text-slate-400">{campaign.reelLink}</span>
          </p>
        )}
      </Card>

      {/* ----------------------------------------------------- attachments */}
      <Card
        title="File attachments"
        description="Sent with every message in the campaign."
        actions={
          attachments.length > 0 && (
            <button type="button" onClick={() => onAttachmentsChange([])} className="btn-ghost btn-sm">
              Clear all
            </button>
          )
        }
      >
        {/* Drop zone */}
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            dragCounter.current += 1;
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragCounter.current -= 1;
            // Only clear once every nested element has been left, otherwise
            // moving over a child element flickers the highlight off.
            if (dragCounter.current <= 0) setIsDragging(false);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          className={`relative rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
            isDragging ? 'border-brand-500 bg-brand-500/10' : 'border-ink-600 bg-ink-900/40 hover:border-ink-500'
          }`}
        >
          <input
            type="file"
            multiple
            id="attachment-input"
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
            aria-label="Choose files to attach"
          />
          <Upload size={22} className={`mx-auto mb-2 ${isDragging ? 'text-brand-400' : 'text-slate-500'}`} />
          <p className="text-sm font-medium text-slate-300">
            {isDragging ? 'Drop to attach' : 'Drag files here, or click to browse'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Up to {formatBytes(MAX_ATTACHMENT_BYTES)} in total across all files
          </p>
        </div>

        {/* Budget meter */}
        {attachments.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-slate-400">
                {attachments.length} file{attachments.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
              </span>
              <span className={percentUsed > 85 ? 'text-amber-400' : 'text-slate-500'}>{percentUsed}% of budget</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
              <div
                className={`h-full rounded-full transition-all ${percentUsed > 85 ? 'bg-amber-500' : 'bg-brand-500'}`}
                style={{ width: `${percentUsed}%` }}
              />
            </div>

            <ul className="mt-3 flex flex-col gap-1.5">
              {attachments.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/50 px-3 py-2"
                >
                  <Paperclip size={14} className="shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-200">{file.filename}</p>
                    <p className="text-[11px] text-slate-500">
                      {formatBytes(file.size)} · {file.contentType}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== file.id))}
                    className="shrink-0 rounded p-1.5 text-slate-600 transition-colors hover:bg-red-950/50 hover:text-red-400"
                    aria-label={`Remove ${file.filename}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <Alert tone="error" className="mt-4" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Alert tone="warn" className="mt-4" title="Attachments cost you replies">
          Cold e-mail with an attachment is filtered far more aggressively than plain text, and a first message from an
          unknown sender is the worst possible moment to ask someone to open a file. Link to hosted work instead —
          that is what the reel links above are for.
        </Alert>

        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          <span>
            Attachments live in memory only and are cleared when you reload the page — file data is far too large for
            browser storage, and evicting your leads to make room for a PDF would be a bad trade.
          </span>
        </p>
      </Card>

      {/* Quick sanity summary */}
      {(attachments.length > 0 || campaign.reelLink) && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-ink-700 bg-ink-850 px-4 py-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} className="text-emerald-400" />
            Ready to attach to every send:
          </span>
          {campaign.reelLink && (
            <span className="inline-flex items-center gap-1.5">
              <Film size={12} />1 reel link
            </span>
          )}
          {attachments.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Paperclip size={12} />
              {attachments.length} file{attachments.length === 1 ? '' : 's'} ({formatBytes(totalBytes)})
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Derives a readable label from a URL when the user does not supply one. */
function guessLabel(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, '');

    if (/youtube|youtu\.be/.test(host)) return 'YouTube reel';
    if (/vimeo/.test(host)) return 'Vimeo reel';
    if (/drive\.google/.test(host)) return 'Google Drive';
    if (/dropbox/.test(host)) return 'Dropbox';
    if (/instagram/.test(host)) return 'Instagram';
    if (/behance/.test(host)) return 'Behance';
    if (/dribbble/.test(host)) return 'Dribbble';
    if (/loom/.test(host)) return 'Loom video';

    const segment = pathname.split('/').filter(Boolean).pop();
    return segment ? `${host} — ${segment.slice(0, 24)}` : host;
  } catch {
    return 'Portfolio link';
  }
}
