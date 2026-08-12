/**
 * lib/drive.js
 * ---------------------------------------------------------------------------
 * Google Drive link handling for the attachment manager.
 *
 * Why links and not real Drive attachments: attaching an actual Drive *file*
 * through SMTP means downloading the bytes and sending them, which needs Google
 * OAuth, the Drive API, and a consent screen — and lands you right back in
 * attachment-filter territory. A Drive **link** is what people actually want
 * here: nothing to attach, no size limit, it renders as a rich preview in
 * Gmail, and you can swap the file's contents later without resending.
 *
 * What this module does is make those links behave: it recognises the various
 * Google URL shapes, pulls out the file id, and rewrites sharing URLs into
 * clean viewer links. It cannot check permissions — that is a Google-side
 * setting — so the UI warns about it instead.
 *
 * Isomorphic, no dependencies.
 */

/** Recognised Google file types and how their URLs are built. */
const GOOGLE_PATTERNS = [
  { kind: 'drive-file', label: 'Drive file', re: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/, view: (id) => `https://drive.google.com/file/d/${id}/view` },
  { kind: 'drive-open', label: 'Drive file', re: /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/, view: (id) => `https://drive.google.com/file/d/${id}/view` },
  { kind: 'drive-uc', label: 'Drive file', re: /drive\.google\.com\/uc\?(?:export=\w+&)?id=([a-zA-Z0-9_-]+)/, view: (id) => `https://drive.google.com/file/d/${id}/view` },
  { kind: 'drive-folder', label: 'Drive folder', re: /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/, view: (id) => `https://drive.google.com/drive/folders/${id}` },
  { kind: 'docs', label: 'Google Doc', re: /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/, view: (id) => `https://docs.google.com/document/d/${id}/view` },
  { kind: 'sheets', label: 'Google Sheet', re: /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/, view: (id) => `https://docs.google.com/spreadsheets/d/${id}/view` },
  { kind: 'slides', label: 'Google Slides', re: /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/, view: (id) => `https://docs.google.com/presentation/d/${id}/view` },
  { kind: 'forms', label: 'Google Form', re: /docs\.google\.com\/forms\/d\/e?\/?([a-zA-Z0-9_-]+)/, view: (id) => `https://docs.google.com/forms/d/e/${id}/viewform` },
];

/**
 * Inspects a URL and, if it is a Google link, returns a normalised form.
 *
 * @param {string} rawUrl
 * @returns {{
 *   isGoogle: boolean, kind: string|null, label: string|null,
 *   fileId: string|null, url: string, cleaned: boolean, warning: string|null
 * }}
 */
export function inspectDriveUrl(rawUrl) {
  const input = String(rawUrl || '').trim();

  const result = {
    isGoogle: false,
    kind: null,
    label: null,
    fileId: null,
    url: input,
    cleaned: false,
    warning: null,
  };

  if (!input) return result;

  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return result;
  }

  result.url = parsed.toString();

  if (!/(^|\.)google\.com$/i.test(parsed.hostname)) return result;

  result.isGoogle = true;

  for (const pattern of GOOGLE_PATTERNS) {
    const match = withProtocol.match(pattern.re);
    if (!match) continue;

    const fileId = match[1];
    const viewUrl = pattern.view(fileId);

    result.kind = pattern.kind;
    result.label = pattern.label;
    result.fileId = fileId;
    result.cleaned = viewUrl !== parsed.toString();
    result.url = viewUrl;

    // `?usp=sharing` and friends are tracking cruft from the Share dialog;
    // stripping them keeps the link tidy and slightly shorter.
    if (parsed.search && /usp=|sharing/.test(parsed.search)) result.cleaned = true;

    // Editing links sent to a stranger either fail or hand out write access —
    // neither is what the sender intended.
    if (/\/edit/.test(parsed.pathname)) {
      result.warning =
        'That was an editing link. It has been changed to a view link — an edit link either fails for the recipient or gives them write access.';
    }

    return result;
  }

  result.warning = 'This looks like a Google link, but not one pointing at a specific file.';
  return result;
}

/**
 * The permission check nobody remembers until a lead replies "I can't open
 * this". There is no way to verify sharing settings without the Drive API, so
 * the honest move is a reminder rather than a false all-clear.
 */
export const DRIVE_PERMISSION_REMINDER =
  'Set the file to "Anyone with the link — Viewer" in Google Drive. Recipients are outside your organisation, ' +
  'so a restricted file shows them a request-access screen instead of your work.';

/** A short label for a link, used when the user does not name it. */
export function describeDriveLink(inspection) {
  if (!inspection?.isGoogle) return '';
  return inspection.label || 'Google Drive link';
}
