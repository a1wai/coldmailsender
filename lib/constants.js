/**
 * lib/constants.js
 * ---------------------------------------------------------------------------
 * Values shared between the browser and the server.
 *
 * This module must stay free of any Node built-in or server-only dependency:
 * client components import it, and pulling in `nodemailer` (via `lib/mailer.js`)
 * or `node:dns` (via `lib/scraper.js`) would break the browser bundle.
 */

/**
 * Total attachment budget per *message*.
 *
 * This one is not a policy choice and cannot be raised: Vercel caps serverless
 * request bodies at roughly 4.5 MB, and base64 inflates binary data by about a
 * third, so 3 MB of real files is the practical ceiling once the JSON envelope
 * is counted. Gmail's own 25 MB limit is well above it and never binds first.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * Total budget for the file library held in the browser.
 *
 * Much larger than what can be *sent*, deliberately. The library is where a
 * showreel, a deck or a case-study PDF lives so it is one click away; files
 * over `MAX_ATTACHMENT_BYTES` are shared as links rather than attached, which
 * is the better move for cold outreach anyway — a stranger's attachment is
 * filtered aggressively, and a link is not.
 */
export const MAX_LIBRARY_BYTES = 50 * 1024 * 1024;

/** Gmail: 500 messages/day on a free account, 2,000 on Workspace. */
export const GMAIL_DAILY_LIMIT = 500;

/** Below roughly this gap, Gmail starts throttling in practice. */
export const MIN_DELAY_SECONDS = 3;

/** Default pacing for a new campaign. */
export const DEFAULT_MIN_DELAY_SECONDS = 5;
export const DEFAULT_MAX_DELAY_SECONDS = 15;
