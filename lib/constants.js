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
 * Total attachment budget per message.
 *
 * Vercel caps serverless request bodies at roughly 4.5 MB, and base64 encoding
 * inflates binary data by about a third — so 3 MB of real files is close to the
 * practical ceiling once the JSON envelope is included.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Gmail: 500 messages/day on a free account, 2,000 on Workspace. */
export const GMAIL_DAILY_LIMIT = 500;

/** Below roughly this gap, Gmail starts throttling in practice. */
export const MIN_DELAY_SECONDS = 3;

/** Default pacing for a new campaign. */
export const DEFAULT_MIN_DELAY_SECONDS = 5;
export const DEFAULT_MAX_DELAY_SECONDS = 15;
