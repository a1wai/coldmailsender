/**
 * lib/template-builder.js
 * ---------------------------------------------------------------------------
 * Assembles a ready-to-send template from a handful of answers, with no API
 * key and no network call.
 *
 * This is the default path for the template wizard, and it is deliberately
 * deterministic rather than generative: it costs nothing, works offline, and
 * produces the structure that actually gets replies — short, specific, one ask,
 * an easy way out. An optional Claude-powered mode sits on top for users who
 * want fresh wording (see `/api/ai-template`).
 *
 * Isomorphic — the wizard previews client-side, the API route reuses it as its
 * fallback.
 */

/** How the opening line frames the outreach. */
export const ANGLES = [
  {
    id: 'observation',
    label: 'I noticed something specific',
    hint: 'Strongest option. Mention something real about their business.',
  },
  { id: 'offer', label: 'Straight to the offer', hint: 'Fast and honest. Works for busy trades.' },
  { id: 'free_sample', label: 'Offer a free sample first', hint: 'Highest reply rate; costs you time up front.' },
  { id: 'question', label: 'Open with a question', hint: 'Low pressure, invites a one-line reply.' },
];

export const TONES = [
  { id: 'plain', label: 'Plain and direct' },
  { id: 'warm', label: 'Warm and friendly' },
  { id: 'professional', label: 'Formal / professional' },
];

const OPENERS = {
  observation: {
    plain: 'I came across {{business}} while looking at {{industry|businesses}} in {{location|the area}}, and one thing stood out:',
    warm: "I've been looking through {{industry|businesses}} around {{location|here}} and {{business}} caught my eye —",
    professional: 'I recently reviewed {{business}} while researching {{industry|businesses}} in {{location|the area}}, and noted the following:',
  },
  offer: {
    plain: 'I do {{product}} for {{industry|businesses}} like {{business}}.',
    warm: "I help {{industry|businesses}} like {{business}} with {{product}} — thought it might be worth a quick note.",
    professional: 'I provide {{product}} to {{industry|businesses}} such as {{business}}.',
  },
  free_sample: {
    plain: "I'd like to make you something for free.",
    warm: "I'd love to put something together for you, no charge.",
    professional: 'I would like to offer a complimentary sample of my work.',
  },
  question: {
    plain: 'Quick question — who handles {{product}} for {{business}}?',
    warm: "Quick one for you — is {{product}} something {{business}} is thinking about right now?",
    professional: 'May I ask who is responsible for {{product}} at {{business}}?',
  },
};

const CLOSERS = {
  plain: 'Worth a look?',
  warm: 'Happy to send more if it looks useful!',
  professional: 'I would welcome the opportunity to discuss further.',
};

const SIGN_OFFS = { plain: 'Best,', warm: 'Cheers,', professional: 'Kind regards,' };

/** Subject lines by angle. Lower-case and specific out-performs Title Case Marketing. */
const SUBJECTS = {
  observation: ['quick idea for {{business}}', '{{business}} — one thought', 'noticed something on your site'],
  offer: ['{{product}} for {{business}}?', 'quick note about {{product}}', '{{business}} + {{product}}'],
  free_sample: ['free {{product}} sample for {{business}}', 'made something for {{business}}?', 'a free sample, no strings'],
  question: ['who handles {{product}} at {{business}}?', 'quick question, {{first_name|there}}', 'question about {{business}}'],
};

/**
 * Builds a template from the wizard answers.
 *
 * @param {object} answers
 * @param {string} answers.service       What you do ("short-form video editing").
 * @param {string} answers.audience      Who you target ("local restaurants").
 * @param {string} answers.observation   The specific thing you noticed (angle: observation).
 * @param {string} answers.outcome       The result you get people ("more bookings").
 * @param {string} answers.angle         An id from ANGLES.
 * @param {string} answers.tone          An id from TONES.
 * @param {boolean} answers.includeReel  Insert {{reel_link}}.
 * @param {boolean} answers.offerSample  Add a free-sample line.
 * @returns {{ name: string, subject: string, body: string, tags: string[] }}
 */
export function buildTemplate(answers = {}) {
  const {
    service = 'my work',
    audience = '',
    observation = '',
    outcome = '',
    angle = 'observation',
    tone = 'plain',
    includeReel = true,
    offerSample = false,
  } = answers;

  const toneKey = TONES.some((t) => t.id === tone) ? tone : 'plain';
  const angleKey = ANGLES.some((a) => a.id === angle) ? angle : 'observation';

  const lines = [];

  // Greeting — the fallback matters more than the name, because a lead with no
  // contact name is the common case.
  lines.push(`Hi {{first_name|there}},`);
  lines.push('');

  // Opening.
  let opener = OPENERS[angleKey][toneKey];
  if (angleKey === 'observation' && observation.trim()) {
    opener = `${opener} ${observation.trim().replace(/\.$/, '')}.`;
  } else if (angleKey === 'observation') {
    // No specific observation supplied — fall back to something honest rather
    // than inventing a compliment that will read as automated.
    opener = OPENERS.offer[toneKey];
  }
  lines.push(opener);
  lines.push('');

  // What you do and why it matters.
  const valueLine = outcome.trim()
    ? `I do {{product|${escapePlaceholderText(service)}}} — usually so ${lowerFirst(outcome.trim().replace(/\.$/, ''))}.`
    : `I do {{product|${escapePlaceholderText(service)}}}.`;

  if (angleKey !== 'offer') lines.push(valueLine);
  else if (outcome.trim()) lines.push(`Usually that means ${lowerFirst(outcome.trim().replace(/\.$/, ''))}.`);

  if (includeReel) {
    lines.push('');
    lines.push(`Here's a short example of recent work: {{reel_link}}`);
  }

  // The ask — exactly one, and small.
  lines.push('');
  if (offerSample || angleKey === 'free_sample') {
    lines.push(
      `If it's useful, I'll put together a sample for {{business}} first — free, and no obligation to use it.`,
    );
  } else {
    lines.push(CLOSERS[toneKey]);
  }

  // The way out. This is what keeps the message honest and the replies civil.
  lines.push('');
  lines.push(`If this isn't relevant, just reply "no thanks" and I won't follow up.`);

  lines.push('');
  lines.push(SIGN_OFFS[toneKey]);
  lines.push('{{sender_name}}');

  const subjectPool = SUBJECTS[angleKey];
  const subject = subjectPool[Math.floor(Math.random() * subjectPool.length)];

  const nameParts = [service.trim() || 'Outreach'];
  if (audience.trim()) nameParts.push(`→ ${audience.trim()}`);

  return {
    name: nameParts.join(' ').slice(0, 60),
    subject,
    body: lines.join('\n'),
    tags: [angleKey.replace('_', '-'), toneKey].filter(Boolean),
  };
}

/** Builds the short follow-up that belongs with any first-contact template. */
export function buildFollowUp(answers = {}, originalSubject = '') {
  const tone = TONES.some((t) => t.id === answers.tone) ? answers.tone : 'plain';

  const body = [
    'Hi {{first_name|there}},',
    '',
    'Floating this back up in case it got buried.',
    answers.includeReel === false ? '' : '',
    answers.includeReel === false ? '' : `Still happy to send that example over: {{reel_link}}`,
    '',
    `Either way this is my last note — I won't keep chasing.`,
    '',
    SIGN_OFFS[tone],
    '{{sender_name}}',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');

  return {
    name: 'Follow-up (send 4–5 days later)',
    subject: originalSubject ? `Re: ${originalSubject}` : 'Re: quick idea for {{business}}',
    body,
    tags: ['follow-up'],
  };
}

function lowerFirst(value) {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

/** Strips braces so free text can never break the placeholder syntax. */
function escapePlaceholderText(value) {
  return String(value).replace(/[{}|]/g, '');
}
