/**
 * lib/ai-extract.js
 * ---------------------------------------------------------------------------
 * Optional Claude pass over crawled page text, to pick the *right* contact
 * rather than merely a valid one.
 *
 * What the regex crawler cannot do, and this can:
 *   - Choose between six addresses on a page by reading who they belong to
 *     ("careers@" on a recruitment page is not the person to pitch).
 *   - Attach a name and job title to an address when the markup gives no
 *     structural hint that they belong together.
 *   - Read an address a human can see but no regex matches — spelled out as
 *     "sarah dot jansen at studionoord dot nl", or split across elements.
 *   - Say the business name as a person would, not as the <title> tag does.
 *
 * Strictly an enhancement: the crawler's own result stands when no
 * ANTHROPIC_API_KEY is set, and any failure here falls back to it silently.
 * This is the one paid path in the app — see the note in the README.
 *
 * Server-only.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

/** Cap the text per site so a sprawling page cannot dominate the request. */
const MAX_CHARS_PER_SITE = 9000;

const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    email: {
      type: 'string',
      description: 'The single best e-mail address to contact this business for a business proposal. Empty string if the pages contain none.',
    },
    name: {
      type: 'string',
      description: "The contact person's full name if the pages state one, otherwise an empty string. Never guess.",
    },
    role: {
      type: 'string',
      description: "That person's job title if stated, otherwise an empty string.",
    },
    business: {
      type: 'string',
      description: 'The business name as a person would write it. Empty string if unclear.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How confident you are that this address reaches a decision-maker.',
    },
    reason: {
      type: 'string',
      description: 'One short sentence on why you chose this address over the others.',
    },
  },
  required: ['email', 'name', 'role', 'business', 'confidence', 'reason'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You read text scraped from a business's own website and identify the best single contact for a cold business proposal.

Rules:
- Return an address that literally appears in the text. Never invent, complete, or guess one. If the text spells an address out ("sarah dot jansen at example dot com"), reconstruct it — that is reading, not guessing.
- Prefer, in order: a named decision-maker (owner, founder, director, manager) > a general business inbox (hello@, contact@, info@) > a department inbox. Actively avoid careers@/jobs@ (recruitment), press@/media@ (journalists), privacy@/legal@/dpo@ (compliance), and support@ unless nothing else exists.
- Only return a name if the text states that person's name in connection with the business. An author byline on a blog post is not the contact. If in doubt, return an empty string — a wrong name is far worse than none, because it goes straight into the greeting of the e-mail.
- Do not return an address belonging to a different company (a web designer's credit in the footer, a supplier, a directory).
- If there is genuinely no usable address, return an empty string for email and set confidence to "low".`;

export function isAiExtractionEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Reads one site's crawled pages and returns the best contact.
 *
 * @param {object} site
 * @param {string} site.website
 * @param {Array<{url: string, text: string}>} site.pageTexts
 * @param {string[]} [site.candidateEmails]  What the regex crawler already found.
 * @returns {Promise<object|null>} null when disabled or unusable.
 */
export async function extractContactWithAi(site) {
  if (!isAiExtractionEnabled()) return null;

  const pages = (site.pageTexts || []).filter((page) => page.text?.trim());
  if (!pages.length) return null;

  const client = new Anthropic();

  let budget = MAX_CHARS_PER_SITE;
  const sections = [];
  for (const page of pages) {
    if (budget <= 0) break;
    const slice = page.text.slice(0, Math.min(budget, 4000));
    budget -= slice.length;
    sections.push(`--- ${page.url} ---\n${slice}`);
  }

  const candidates = site.candidateEmails?.length
    ? `\n\nAddresses a regex already found on these pages (may be incomplete or wrong): ${site.candidateEmails.join(', ')}`
    : '\n\nA regex found no addresses on these pages. Read carefully — one may be spelled out or split up.';

  try {
    const response = await client.messages.create({
      model: MODEL,
      // Thinking shares this budget on Opus 5, so leave real headroom or the
      // JSON truncates mid-string.
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: {
        // A short extraction from provided text — low effort is plenty.
        effort: 'low',
        format: { type: 'json_schema', schema: CONTACT_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: `Website: ${site.website}${candidates}\n\nPage text:\n\n${sections.join('\n\n')}`,
        },
      ],
    });

    if (response.stop_reason === 'refusal') return null;

    const text = response.content.find((block) => block.type === 'text')?.text || '';
    const parsed = JSON.parse(text);

    const email = String(parsed.email || '').trim().toLowerCase();

    // Guard against a hallucinated address: it must actually occur in the text
    // we supplied. Cheap to check and the failure mode it prevents — mailing a
    // made-up address — is exactly the one that matters.
    if (email) {
      const haystack = sections.join(' ').toLowerCase().replace(/\s+/g, '');
      const spelledOut = haystack.includes(email.replace(/\s+/g, ''));
      if (!spelledOut && !looksReconstructed(email, haystack)) return null;
    }

    return {
      email,
      name: String(parsed.name || '').trim(),
      role: String(parsed.role || '').trim(),
      business: String(parsed.business || '').trim(),
      confidence: parsed.confidence || 'low',
      reason: String(parsed.reason || '').trim(),
    };
  } catch (error) {
    console.warn('[ai-extract] Falling back to the crawler result:', error.message);
    return null;
  }
}

/**
 * Accepts an address the model reconstructed from an obfuscated spelling —
 * "sarah dot jansen at example dot com" — by checking that its parts are all
 * present in the source text.
 */
function looksReconstructed(email, haystack) {
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) return false;

  const parts = [...localPart.split('.'), ...domain.split('.')].filter((part) => part.length > 1);
  return parts.every((part) => haystack.includes(part));
}
