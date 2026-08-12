/**
 * lib/templates.js
 * ---------------------------------------------------------------------------
 * Placeholder rendering for e-mail templates.
 *
 * Syntax: `{{placeholder}}` — case-insensitive, whitespace-tolerant, with an
 * optional fallback after a pipe:
 *
 *   {{name}}                     → "Sarah"
 *   {{ business }}               → "Acme Studio"
 *   {{name|there}}               → "there"  (when `name` is empty)
 *   {{reel_link}}                → the currently selected portfolio link
 *   {{anything_you_invent}}      → resolved from the lead's custom fields
 *
 * Isomorphic — imported by both client components and API routes.
 */

/** Placeholders every lead carries. Surfaced in the UI as insertable chips. */
export const BUILT_IN_PLACEHOLDERS = [
  { key: 'name', label: 'Contact name', example: 'Sarah' },
  { key: 'first_name', label: 'First name only', example: 'Sarah' },
  { key: 'business', label: 'Business name', example: 'Acme Studio' },
  { key: 'website', label: 'Website URL', example: 'https://acme.studio' },
  { key: 'email', label: 'Recipient e-mail', example: 'hello@acme.studio' },
  { key: 'domain', label: 'Bare domain', example: 'acme.studio' },
  { key: 'industry', label: 'Target industry', example: 'interior design' },
  { key: 'location', label: 'City / location', example: 'Rotterdam' },
  { key: 'product', label: 'What you are offering', example: 'short-form video editing' },
  { key: 'reel_link', label: 'Portfolio / reel link', example: 'https://youtu.be/xyz' },
  { key: 'sender_name', label: 'Your name', example: 'Martyn' },
];

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|([^}]*))?\}\}/g;

/**
 * Returns every distinct placeholder key used in a string.
 * Powers the "this template needs X" warnings in the Template Manager.
 */
export function extractPlaceholders(...sources) {
  const keys = new Set();

  for (const source of sources) {
    if (!source) continue;
    for (const match of String(source).matchAll(PLACEHOLDER_RE)) {
      keys.add(match[1].toLowerCase());
    }
  }

  return [...keys];
}

/**
 * Builds the variable map for one lead. Later arguments win, so campaign-level
 * defaults can be overridden by per-lead custom fields.
 */
export function buildVariables(lead = {}, globals = {}) {
  const email = lead.email || '';
  const website = lead.website || '';
  const name = (lead.name || '').trim();

  let domain = '';
  if (website) {
    try {
      domain = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
    } catch {
      domain = website.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0];
    }
  } else if (email.includes('@')) {
    domain = email.split('@')[1];
  }

  return {
    ...globals,
    ...(lead.customFields || {}),
    name,
    first_name: name ? name.split(/\s+/)[0] : '',
    business: lead.business || '',
    website,
    email,
    domain,
    // Campaign-level values (product, reel_link, industry, location,
    // sender_name) arrive via `globals` and are preserved unless the lead
    // overrides them through a custom field.
  };
}

/**
 * Substitutes placeholders in a string.
 *
 * @param {string} template
 * @param {object} variables
 * @param {object} [options]
 * @param {'empty'|'keep'} [options.onMissing='empty']  What to do with unknown keys.
 * @returns {{ output: string, missing: string[] }}
 */
export function renderTemplate(template, variables = {}, options = {}) {
  const onMissing = options.onMissing || 'empty';
  const missing = new Set();

  // Case-insensitive lookup without mutating the caller's object.
  const lookup = new Map(Object.entries(variables).map(([k, v]) => [k.toLowerCase(), v]));

  const output = String(template || '').replace(PLACEHOLDER_RE, (match, rawKey, fallback) => {
    const key = rawKey.toLowerCase();
    const value = lookup.get(key);

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }

    if (fallback !== undefined) return fallback.trim();

    missing.add(key);
    return onMissing === 'keep' ? match : '';
  });

  return { output: tidy(output), missing: [...missing] };
}

/**
 * Renders subject + body for one lead in a single pass.
 * Returns everything the send route needs.
 */
export function renderEmail(template, lead, globals = {}, options = {}) {
  const variables = buildVariables(lead, globals);
  const subject = renderTemplate(template.subject || '', variables, options);
  const body = renderTemplate(template.body || '', variables, options);

  return {
    subject: subject.output,
    body: body.output,
    html: textToHtml(body.output),
    missing: [...new Set([...subject.missing, ...body.missing])],
    variables,
  };
}

/**
 * Collapses the artefacts left behind when a placeholder resolves to nothing:
 * "Hi ," becomes "Hi,", and doubled spaces are squeezed. Without this, one
 * missing name makes an otherwise-good e-mail look automated.
 */
function tidy(value) {
  return value
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([,;:])\s*([,.;:!?])/g, '$2')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '');
}

/**
 * Converts the plain-text body users type into simple, deliverable HTML.
 *
 * Kept intentionally minimal: bare-bones HTML with inline styles reaches the
 * inbox far more reliably than a heavily-designed template, which is exactly
 * what cold outreach needs.
 */
export function textToHtml(text) {
  const escaped = escapeHtml(String(text || ''));

  const linked = escaped
    // Autolink bare URLs. Trailing punctuation is excluded from the match so
    // "see https://x.com." does not produce a broken link.
    .replace(
      /(https?:\/\/[^\s<]+[^\s<.,:;!?)"'])/g,
      '<a href="$1" style="color:#4f46e5;">$1</a>',
    )
    // **bold** → <strong>
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // *italic* → <em>
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');

  const paragraphs = linked
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 16px 0;">${block.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.6;color:#1f2937;max-width:600px;">` +
    (paragraphs || '<p style="margin:0;"></p>') +
    `</div>`
  );
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Starter templates, so the app is useful on first run and there is something
 * concrete to edit rather than a blank box.
 *
 * All of them follow the same shape, because it is the shape that gets
 * replies: short, one specific reason for writing, one small ask, and an
 * explicit way out at the end.
 */
export function createDefaultTemplates() {
  const now = Date.now();

  const templates = [
    {
      name: 'Video editor → local business',
      tags: ['video', 'intro'],
      subject: 'quick idea for {{business}}',
      body:
        `Hi {{first_name|there}},\n\n` +
        `I came across {{business}} while looking at {{industry|businesses}} in {{location|the area}}, ` +
        `and I had a specific idea for your socials.\n\n` +
        `I do {{product|short-form video editing}} — here's 30 seconds of recent work: {{reel_link}}\n\n` +
        `If it's useful, I'll cut a sample from your own footage first — free, and no obligation.\n\n` +
        `If this isn't relevant, just reply "no thanks" and I won't follow up.\n\n` +
        `Best,\n{{sender_name}}`,
    },
    {
      name: 'Follow-up (send 4–5 days later)',
      tags: ['follow-up'],
      subject: 'Re: quick idea for {{business}}',
      body:
        `Hi {{first_name|there}},\n\n` +
        `Floating this back up in case it got buried.\n\n` +
        `Still happy to send that sample over: {{reel_link}}\n\n` +
        `Either way this is my last note — I won't keep chasing.\n\n` +
        `Cheers,\n{{sender_name}}`,
    },
    {
      name: 'Web designer → dated site',
      tags: ['web', 'intro'],
      subject: '{{business}} — one thought on the site',
      body:
        `Hi {{first_name|there}},\n\n` +
        `I was looking through {{industry|businesses}} in {{location|the area}} and spent a minute on your site.\n\n` +
        `I build sites for {{industry|small businesses}} — mostly making them load faster and work properly on ` +
        `a phone, which is where nearly all the traffic is. Recent work: {{reel_link}}\n\n` +
        `Want me to send over a couple of specific things I'd change? No charge, takes me ten minutes.\n\n` +
        `If not, reply "no thanks" and that's the end of it.\n\n` +
        `Best,\n{{sender_name}}`,
    },
    {
      name: 'Photographer → hospitality',
      tags: ['photo', 'intro'],
      subject: 'photos for {{business}}?',
      body:
        `Hi {{first_name|there}},\n\n` +
        `I shoot for {{industry|restaurants and cafés}} around {{location|here}} — food, interiors, the ` +
        `occasional staff portrait. Portfolio: {{reel_link}}\n\n` +
        `Most places I work with use the shots for their menus, socials and delivery listings, so one session ` +
        `covers a lot of ground.\n\n` +
        `Worth a conversation?\n\n` +
        `If it's not the right time, just say so and I'll leave it there.\n\n` +
        `Cheers,\n{{sender_name}}`,
    },
    {
      name: 'Freelance writer → agency',
      tags: ['writing', 'b2b'],
      subject: 'overflow writing for {{business}}?',
      body:
        `Hi {{first_name|there}},\n\n` +
        `I write for {{industry|agencies}} — mostly long-form and landing pages, usually as overflow when a ` +
        `team is at capacity.\n\n` +
        `Samples: {{reel_link}}\n\n` +
        `If you keep a list of freelancers, I'd like to be on it. Happy to do a paid test piece so you can see ` +
        `how I work before anything bigger.\n\n` +
        `Not looking for work right now? No problem — just reply and I'll stop here.\n\n` +
        `Best,\n{{sender_name}}`,
    },
    {
      name: 'Straight to the point (no fluff)',
      tags: ['short', 'intro'],
      subject: '{{product}} for {{business}}?',
      body:
        `Hi {{first_name|there}},\n\n` +
        `Short version: I do {{product}} for {{industry|businesses}} like yours.\n\n` +
        `Example of the work: {{reel_link}}\n\n` +
        `Interested?\n\n` +
        `If not, reply "no" and I won't write again.\n\n` +
        `{{sender_name}}`,
    },
    {
      name: 'Free sample first',
      tags: ['sample', 'intro'],
      subject: 'made something for {{business}}?',
      body:
        `Hi {{first_name|there}},\n\n` +
        `I'd like to make you something for free.\n\n` +
        `I do {{product}}, and the easiest way to show you it's any good is to just do it — so if you're ` +
        `interested, I'll put together a sample for {{business}} this week. No charge, no obligation to use it.\n\n` +
        `Here's the standard of work you'd get: {{reel_link}}\n\n` +
        `Just reply "yes" and I'll get started. If it's a no, that's completely fine — reply and I'll leave you be.\n\n` +
        `Cheers,\n{{sender_name}}`,
    },
    {
      name: 'Formal / professional services',
      tags: ['formal', 'b2b'],
      subject: '{{product}} enquiry — {{business}}',
      body:
        `Dear {{first_name|Sir or Madam}},\n\n` +
        `I am writing regarding {{product}} for {{business}}.\n\n` +
        `I work with {{industry|organisations}} in {{location|the region}}, and examples of previous work are ` +
        `available here: {{reel_link}}\n\n` +
        `If this is of interest, I would welcome a short conversation at your convenience.\n\n` +
        `Should you prefer not to receive further correspondence, please reply to this message and I will ` +
        `remove your details.\n\n` +
        `Kind regards,\n{{sender_name}}`,
    },
  ];

  return templates.map((template, index) => ({
    ...template,
    id: `tpl_${now + index}`,
    createdAt: now + index,
    updatedAt: now + index,
  }));
}
