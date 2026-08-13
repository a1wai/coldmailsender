'use client';

/**
 * components/MessageStudio.jsx  —  Tab 2 (Write message)
 * ---------------------------------------------------------------------------
 * Everything that makes up the message: the template editor, and the files and
 * links that get shared alongside it.
 *
 * These used to be two tabs. They belong together — the template references
 * `{{reel_link}}`, and the link it resolves to is chosen here, so splitting
 * them meant tabbing back and forth to answer "what will this actually send?".
 *
 * The guided wizard used to be a third section here and is no longer a
 * destination of its own. Eight starter templates ship with the app, so the
 * editor is never an empty room, and landing on a five-question form before
 * you have seen a single template was the wrong first impression. The wizard
 * still exists — it opens from a button inside the template editor, which is
 * where someone actually decides they want a new one.
 */

import { useState } from 'react';
import { FileText, Paperclip } from 'lucide-react';
import TemplateManager from './TemplateManager';
import AttachmentManager from './AttachmentManager';
import TemplateWizard from './TemplateWizard';

const SECTIONS = [
  { id: 'templates', label: 'My templates', icon: FileText },
  { id: 'files', label: 'Files & links', icon: Paperclip },
];

export default function MessageStudio({
  templates,
  onTemplatesChange,
  attachments,
  onAttachmentsChange,
  reelLinks,
  onReelLinksChange,
  campaign,
  onCampaignChange,
  sampleLead,
  scraperSettings,
}) {
  const [section, setSection] = useState('templates');
  const [wizardOpen, setWizardOpen] = useState(false);

  function handleWizardCreate(created) {
    const now = Date.now();
    const withIds = created.map((template, index) => ({
      ...template,
      id: `tpl_${now + index}`,
      createdAt: now + index,
      updatedAt: now + index,
    }));

    onTemplatesChange([...templates, ...withIds]);

    // The wizard's job is done; editing the result is the natural next step.
    setWizardOpen(false);
    setSection('templates');
  }

  const counts = {
    templates: templates.length,
    files: attachments.length + reelLinks.length,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Segmented control */}
      <div className="glass flex flex-wrap gap-1 p-1.5">
        {SECTIONS.map((entry) => {
          const Icon = entry.icon;
          const isActive = section === entry.id;

          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              aria-pressed={isActive}
              className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
                isActive
                  ? 'bg-brand-gradient text-white shadow-glow-sm'
                  : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-100'
              }`}
            >
              <Icon size={14} />
              <span className="whitespace-nowrap">{entry.label}</span>
              {counts[entry.id] > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                    isActive ? 'bg-white/20 text-white' : 'bg-white/[0.08] text-slate-400'
                  }`}
                >
                  {counts[entry.id]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Opened from the template editor rather than living in the tab bar. */}
      {wizardOpen && (
        <TemplateWizard
          onCreate={handleWizardCreate}
          onCancel={() => setWizardOpen(false)}
          campaign={campaign}
          sampleLead={sampleLead}
          defaults={{ service: campaign?.product || '', audience: scraperSettings?.industry || '' }}
        />
      )}

      {section === 'templates' && !wizardOpen && (
        <TemplateManager
          templates={templates}
          onTemplatesChange={onTemplatesChange}
          campaign={campaign}
          sampleLead={sampleLead}
          onStartWizard={() => setWizardOpen(true)}
        />
      )}

      {section === 'files' && !wizardOpen && (
        <AttachmentManager
          attachments={attachments}
          onAttachmentsChange={onAttachmentsChange}
          reelLinks={reelLinks}
          onReelLinksChange={onReelLinksChange}
          campaign={campaign}
          onCampaignChange={onCampaignChange}
        />
      )}
    </div>
  );
}
