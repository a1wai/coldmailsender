/**
 * POST /api/ai-template
 * ---------------------------------------------------------------------------
 * Turns the wizard's answers into a finished template.
 *
 * Two modes, and the free one is the default:
 *
 *   - No `ANTHROPIC_API_KEY`  → `lib/template-builder.js` assembles the
 *     template deterministically. Costs nothing, works offline, and is what
 *     most people should use.
 *   - With `ANTHROPIC_API_KEY` → Claude writes it, given the same answers.
 *     Better wording, genuinely different output each run. **This is the one
 *     part of the app that is not free** — the Anthropic API is paid, with no
 *     permanent free tier. The UI says so before you use it.
 *
 * Response: { ok: true, template: { name, subject, body, tags }, source }
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildTemplate } from '@/lib/template-builder';
import { jsonOk, jsonError, readJsonBody, rateLimit, clientKey } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODEL = 'claude-opus-5';

/** The shape Claude must return, enforced by the API rather than by parsing hope. */
const TEMPLATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short internal name for this template, under 60 characters.' },
    subject: { type: 'string', description: 'Subject line. Lower-case, specific, under 60 characters.' },
    body: {
      type: 'string',
      description:
        'The e-mail body as plain text with \\n line breaks. Must use the placeholders described in the prompt.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'One to three short lower-case tags.',
    },
  },
  required: ['name', 'subject', 'body', 'tags'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You write cold outreach e-mails that get replies.

What works, and what you must do:
- Short. Under 120 words in the body. Every sentence earns its place.
- Specific to the recipient. Generic praise ("love your website!") reads as automated and gets deleted.
- Exactly one ask, and make it small. Never stack two requests.
- Plain language. No marketing voice, no "I hope this email finds you well", no "I wanted to reach out", no buzzwords, no exclamation marks unless the tone is explicitly warm.
- Lower-case, specific subject lines out-perform Title Case Marketing Subject Lines.
- Always give the recipient an easy way out in the final lines. This is not optional: it is what separates outreach from spam, and it is what keeps replies civil.
- Never invent facts about the recipient's business. You do not know their revenue, their team size, or their problems. If the user supplied a specific observation, use it; otherwise stay general and honest rather than fabricating detail.

Placeholders are filled per-recipient at send time. Use them:
  {{first_name|there}}  contact's first name, with a fallback
  {{business}}          the business name
  {{product}}           what the sender offers
  {{reel_link}}         the sender's portfolio link
  {{sender_name}}       the sender's name
  {{industry}} {{location}}  the target industry and place
Write {{first_name|there}} rather than {{first_name}} — most leads have no contact name, and "Hi ," ruins the message.

Return the body as plain text with \\n line breaks. No HTML, no markdown headings.`;

export async function POST(request) {
  const limit = rateLimit(`ai-template:${clientKey(request)}`, { limit: 15, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonError(`Too many requests. Wait ${limit.retryAfter}s.`, 429, { retryAfter: limit.retryAfter });
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch (error) {
    return jsonError(error.message, error.status || 400);
  }

  const answers = body.answers || {};

  // Deterministic path — no key configured, or the caller asked for it.
  if (!process.env.ANTHROPIC_API_KEY || body.useAi === false) {
    return jsonOk({ template: buildTemplate(answers), source: 'builtin' });
  }

  try {
    const client = new Anthropic();

    const response = await client.messages.create({
      model: MODEL,
      // Thinking is on by default on this model and shares the max_tokens
      // budget with the response, so leave real headroom — a tight cap here
      // truncates the JSON mid-string and the parse fails.
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        // A template is short and formulaic; low effort is plenty and keeps
        // the request fast and cheap.
        effort: 'low',
        format: { type: 'json_schema', schema: TEMPLATE_SCHEMA },
      },
      messages: [{ role: 'user', content: buildUserPrompt(answers) }],
    });

    if (response.stop_reason === 'refusal') {
      return jsonOk({
        template: buildTemplate(answers),
        source: 'builtin',
        notice: 'The model declined this request, so the built-in builder was used instead.',
      });
    }

    const text = response.content.find((block) => block.type === 'text')?.text || '';
    const parsed = JSON.parse(text);

    return jsonOk({
      template: {
        name: String(parsed.name || 'Untitled template').slice(0, 80),
        subject: String(parsed.subject || ''),
        body: String(parsed.body || ''),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 4).map(String) : [],
      },
      source: 'claude',
      usage: {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
    });
  } catch (error) {
    console.error('[api/ai-template] Falling back to the built-in builder:', error.message);

    // Never fail the request over the optional path — the user still gets a
    // usable template, plus an honest note about what happened.
    return jsonOk({
      template: buildTemplate(answers),
      source: 'builtin',
      notice: `Claude could not be reached (${describeAnthropicError(error)}). Used the built-in builder instead.`,
    });
  }
}

/** GET reports whether the AI path is available, so the UI can label the button. */
export async function GET() {
  return jsonOk({ available: Boolean(process.env.ANTHROPIC_API_KEY), model: MODEL });
}

function buildUserPrompt(answers) {
  const lines = [
    'Write one cold outreach e-mail template from these answers.',
    '',
    `What I do: ${answers.service || '(not specified)'}`,
    `Who I'm writing to: ${answers.audience || '(not specified)'}`,
  ];

  if (answers.outcome) lines.push(`The result I get people: ${answers.outcome}`);
  if (answers.observation) lines.push(`Something specific I noticed about them: ${answers.observation}`);
  if (answers.angle) lines.push(`Angle for the opening: ${answers.angle.replace(/_/g, ' ')}`);
  if (answers.tone) lines.push(`Tone: ${answers.tone}`);

  lines.push(
    answers.includeReel === false
      ? 'Do not include a portfolio link.'
      : 'Include the {{reel_link}} placeholder once, where a portfolio link belongs.',
  );

  if (answers.offerSample) lines.push('Offer to make a free sample before they commit to anything.');
  if (answers.extras) lines.push(`Also worth knowing: ${answers.extras}`);

  return lines.join('\n');
}

function describeAnthropicError(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'the API key was rejected';
  if (error instanceof Anthropic.RateLimitError) return 'rate limited';
  if (error instanceof Anthropic.APIConnectionError) return 'could not connect';
  if (error instanceof Anthropic.APIStatusError) return `HTTP ${error.status}`;
  if (error instanceof SyntaxError) return 'the response was not valid JSON';
  return error.message || 'unknown error';
}
