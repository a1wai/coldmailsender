'use client';

/**
 * components/MessageStudio.jsx  —  Tab 2 (Write message)
 * ---------------------------------------------------------------------------
 * Everything that makes up the message, in one place: the wizard that writes a
 * template for you, the full template editor, and the files and links that get
 * shared alongside it.
 *
 * These used to be two tabs. They belong together — the template references
 * `{{reel_link}}`, and the link it resolves to is chosen here, so splitting
 * them meant tabbing back and forth to answer "what will this actually send?".
 *
 * A segmented control switches between the three, defaulting to the wizard on
 * a fresh install and the editor once templates exist.
 */

import { useState } from 'react';
import { FileText, Paperclip, Wand2 } from 'lucide-react';
import TemplateManager from './TemplateManager';
import AttachmentManager from './AttachmentManager';
import TemplateWizard from './TemplateWizard';

const SECTIONS = [
  { id: 'wizard', label: 'Write one for me', icon: Wand2 },
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
  // Land on the wizard when there is nothing to edit yet.
  const [section, setSection] = useState(templates.length ? 'templates' : 'wizard');

  function handleWizardCreate(created) {
    const now = Date.now();
    const withIds = created.map((template, index) => ({
      ...template,
      id: `tpl_${now + index}`,
      createdAt: now + index,
      updatedAt: now + index,
    }));

    onTemplatesChange([...templates, ...withIds]);

    // Jump straight to the editor with the new template in the list — the
    // wizard's job is done and editing is the natural next step.
    setSection('templates');
  }

  const counts = {
    wizard: null,
    templates: templates.length,
    files: attachments.length + reelLinks.length,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Segmented control */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-ink-700 bg-ink-850 p-1">
        {SECTIONS.map((entry) => {
          const Icon = entry.icon;
          const isActive = section === entry.id;

          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              aria-pressed={isActive}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200'
              }`}
            >
              <Icon size={14} />
              <span className="whitespace-nowrap">{entry.label}</span>
              {counts[entry.id] > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                    isActive ? 'bg-white/20 text-white' : 'bg-ink-700 text-slate-400'
                  }`}
                >
                  {counts[entry.id]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {section === 'wizard' && (
        <TemplateWizard
          onCreate={handleWizardCreate}
          campaign={campaign}
          sampleLead={sampleLead}
          defaults={{ service: campaign?.product || '', audience: scraperSettings?.industry || '' }}
        />
      )}

      {section === 'templates' && (
        <TemplateManager
          templates={templates}
          onTemplatesChange={onTemplatesChange}
          campaign={campaign}
          sampleLead={sampleLead}
          onStartWizard={() => setSection('wizard')}
        />
      )}

      {section === 'files' && (
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
