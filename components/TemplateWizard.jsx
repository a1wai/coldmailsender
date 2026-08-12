'use client';

/**
 * components/TemplateWizard.jsx
 * ---------------------------------------------------------------------------
 * Answer a few questions, get a finished template.
 *
 * The built-in builder assembles it locally — instant, free, works offline —
 * and is what runs unless the deployment has an ANTHROPIC_API_KEY set. When it
 * does, a second button hands the same answers to Claude for fresh wording.
 *
 * The UI is explicit that the AI route is the one paid part of the app, so
 * nobody discovers that on a bill.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Info, RefreshCw, Sparkles, Wand2 } from 'lucide-react';
import { Alert, Card, SelectField, Spinner, TextAreaField, TextField, Toggle } from './ui';
import { ANGLES, TONES, buildFollowUp, buildTemplate } from '@/lib/template-builder';
import { renderEmail } from '@/lib/templates';

const SAMPLE_LEAD = {
  name: 'Sarah Jansen',
  business: 'Studio Noord',
  website: 'https://studionoord.nl',
  email: 'hello@studionoord.nl',
};

export default function TemplateWizard({ onCreate, campaign, sampleLead, defaults = {} }) {
  const [answers, setAnswers] = useState({
    service: defaults.service || '',
    audience: defaults.audience || '',
    outcome: '',
    observation: '',
    angle: 'observation',
    tone: 'plain',
    includeReel: true,
    offerSample: false,
    extras: '',
  });

  const [preview, setPreview] = useState(null);
  const [source, setSource] = useState('builtin');
  const [notice, setNotice] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [alsoFollowUp, setAlsoFollowUp] = useState(true);

  const update = (patch) => setAnswers((current) => ({ ...current, ...patch }));

  // Ask the server whether the paid AI route is even configured.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/ai-template')
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.ok) setAiAvailable(Boolean(data.available));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const canGenerate = answers.service.trim().length > 1;

  function generateLocally() {
    setPreview(buildTemplate(answers));
    setSource('builtin');
    setNotice(null);
  }

  async function generateWithAi() {
    setGenerating(true);
    setNotice(null);

    try {
      const response = await fetch('/api/ai-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });

      const data = await response.json();

      if (!data.ok) throw new Error(data.error || 'Generation failed.');

      setPreview(data.template);
      setSource(data.source);
      if (data.notice) setNotice({ tone: 'warn', message: data.notice });
    } catch (error) {
      setPreview(buildTemplate(answers));
      setSource('builtin');
      setNotice({ tone: 'warn', message: `${error.message} Used the built-in builder instead.` });
    } finally {
      setGenerating(false);
    }
  }

  function save() {
    if (!preview) return;

    const created = [preview];
    if (alsoFollowUp) created.push(buildFollowUp(answers, preview.subject));

    onCreate(created);
  }

  const rendered = useMemo(() => {
    if (!preview) return null;
    return renderEmail(
      preview,
      sampleLead || SAMPLE_LEAD,
      {
        product: campaign?.product || answers.service,
        reel_link: campaign?.reelLink || 'https://your-portfolio-link',
        sender_name: campaign?.senderName || 'Your Name',
        industry: campaign?.industry || answers.audience,
        location: campaign?.location || '',
      },
      { onMissing: 'keep' },
    );
  }, [preview, sampleLead, campaign, answers.service, answers.audience]);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Build a template from a few questions"
        description="Answer these and you get a working template. Edit it afterwards like any other."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="What do you do?"
            value={answers.service}
            onChange={(event) => update({ service: event.target.value })}
            placeholder="short-form video editing"
            required
            hint="Written as you'd say it out loud."
          />
          <TextField
            label="Who are you writing to?"
            value={answers.audience}
            onChange={(event) => update({ audience: event.target.value })}
            placeholder="local restaurants"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label="What do people get out of it? (optional)"
            value={answers.outcome}
            onChange={(event) => update({ outcome: event.target.value })}
            placeholder="their socials post consistently without extra work"
            hint="The result, not the service."
          />
          <SelectField
            label="How should it open?"
            value={answers.angle}
            onChange={(event) => update({ angle: event.target.value })}
            hint={ANGLES.find((angle) => angle.id === answers.angle)?.hint}
          >
            {ANGLES.map((angle) => (
              <option key={angle.id} value={angle.id}>
                {angle.label}
              </option>
            ))}
          </SelectField>
        </div>

        {answers.angle === 'observation' && (
          <div className="mt-4">
            <TextAreaField
              label="What did you notice about them? (optional)"
              value={answers.observation}
              onChange={(event) => update({ observation: event.target.value })}
              rows={2}
              placeholder="their food photos are great but there's no video on the profile"
              hint="One real, specific detail is worth more than the rest of the e-mail. Leave blank and the opener stays honest and general rather than faking a compliment."
            />
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Tone"
            value={answers.tone}
            onChange={(event) => update({ tone: event.target.value })}
          >
            {TONES.map((tone) => (
              <option key={tone.id} value={tone.id}>
                {tone.label}
              </option>
            ))}
          </SelectField>

          <div className="flex flex-col justify-center gap-3">
            <Toggle
              checked={answers.includeReel}
              onChange={(value) => update({ includeReel: value })}
              label="Include a portfolio link"
              hint="Inserts {{reel_link}}."
            />
            <Toggle
              checked={answers.offerSample}
              onChange={(value) => update({ offerSample: value })}
              label="Offer a free sample"
              hint="Highest reply rate, costs you time."
            />
          </div>
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-edge pt-4">
          <button type="button" onClick={generateLocally} disabled={!canGenerate} className="btn-primary">
            <Wand2 size={15} />
            {preview && source === 'builtin' ? 'Regenerate' : 'Build template'}
          </button>

          {aiAvailable && (
            <button
              type="button"
              onClick={generateWithAi}
              disabled={!canGenerate || generating}
              className="btn-secondary"
              title="Uses the Anthropic API — this call is billed to whoever set the key"
            >
              {generating ? <Spinner size={14} /> : <Sparkles size={14} />}
              Write it with Claude
            </button>
          )}

          {preview && (
            <button type="button" onClick={generateLocally} className="btn-ghost btn-sm" title="Try different wording">
              <RefreshCw size={13} />
              Shuffle subject
            </button>
          )}

          {!canGenerate && <span className="text-xs text-slate-500">Fill in what you do to continue.</span>}
        </div>

        {!aiAvailable && (
          <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
            <Info size={11} className="mt-0.5 shrink-0" />
            <span>
              The builder above is free and runs entirely on your machine. Setting <code>ANTHROPIC_API_KEY</code> adds a
              &ldquo;Write it with Claude&rdquo; button for fresher wording —{' '}
              <strong className="text-slate-400">that one is paid</strong>, unlike everything else in this app.
            </span>
          </p>
        )}

        {notice && (
          <Alert tone={notice.tone} className="mt-4" onDismiss={() => setNotice(null)}>
            {notice.message}
          </Alert>
        )}
      </Card>

      {/* Preview + save */}
      {preview && (
        <Card
          title="Preview"
          description={source === 'claude' ? 'Written by Claude' : 'Built locally — free'}
          actions={
            <>
              <Toggle
                checked={alsoFollowUp}
                onChange={setAlsoFollowUp}
                label="Also create a follow-up"
              />
              <button type="button" onClick={save} className="btn-primary">
                <Check size={15} />
                Save {alsoFollowUp ? 'both' : 'template'}
              </button>
            </>
          }
        >
          <div className="overflow-hidden rounded-lg border border-edge bg-white">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Subject</p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">{rendered?.subject}</p>
            </div>
            <div className="px-4 py-4" dangerouslySetInnerHTML={{ __html: rendered?.html || '' }} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <ArrowRight size={12} />
            <span>
              Saving adds {alsoFollowUp ? 'two templates' : 'one template'} to your list, where you can edit{' '}
              {alsoFollowUp ? 'them' : 'it'} freely.
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
