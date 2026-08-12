/**
 * lib/queue.js
 * ---------------------------------------------------------------------------
 * Client-driven send queue with rate limiting.
 *
 * Why the browser drives the loop instead of the server:
 *   A Vercel serverless function is short-lived (10s on Hobby by default). A
 *   campaign that waits 5–15 seconds between 100 e-mails runs for ~20 minutes
 *   — orders of magnitude past any function timeout. So the browser owns the
 *   schedule and each send is its own sub-second request. The trade-off is
 *   that the tab must stay open; for unattended sending, point the queue at
 *   the QStash adapter instead (`lib/adapters/qstash.js`).
 *
 * The queue is deliberately sequential. Sending in parallel is the single
 * fastest way to get a Gmail account rate-limited.
 */

import { GMAIL_DAILY_LIMIT, MIN_DELAY_SECONDS } from './constants.js';

// Re-exported so campaign UI can import limits and the queue from one module.
export { GMAIL_DAILY_LIMIT, MIN_DELAY_SECONDS };

export const QUEUE_STATE = {
  idle: 'idle',
  running: 'running',
  paused: 'paused',
  stopped: 'stopped',
  done: 'done',
};

/**
 * A sleep that can be cut short by pause or stop.
 * Ticks once per second so the UI can render a live countdown.
 */
function interruptibleWait(ms, { onTick, shouldAbort }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer = null;

    const finish = (reason) => {
      if (timer) clearInterval(timer);
      resolve(reason);
    };

    const tick = () => {
      if (shouldAbort()) return finish('aborted');

      const remaining = Math.max(0, ms - (Date.now() - startedAt));
      onTick?.(Math.ceil(remaining / 1000));

      if (remaining <= 0) finish('elapsed');
    };

    onTick?.(Math.ceil(ms / 1000));
    timer = setInterval(tick, 250);
  });
}

/** Random integer in [min, max] — jitter makes traffic look less robotic. */
function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Creates a send queue.
 *
 * @param {object} config
 * @param {Array}  config.items          Leads to send to.
 * @param {Function} config.sendFn       `async (item, index) => result`. Throws to fail.
 * @param {number} config.minDelaySeconds
 * @param {number} config.maxDelaySeconds
 * @param {number} [config.dailyRemaining] Hard stop when the daily cap is hit.
 * @param {number} [config.maxRetries=1]   Retries for transient failures only.
 * @param {Function} [config.onEvent]      Receives every state change.
 * @returns {{ start, pause, resume, stop, getState }}
 */
export function createSendQueue({
  items,
  sendFn,
  minDelaySeconds = 5,
  maxDelaySeconds = 15,
  dailyRemaining = Infinity,
  maxRetries = 1,
  onEvent = () => {},
}) {
  const minDelay = Math.max(MIN_DELAY_SECONDS, Number(minDelaySeconds) || MIN_DELAY_SECONDS);
  const maxDelay = Math.max(minDelay, Number(maxDelaySeconds) || minDelay);

  let state = QUEUE_STATE.idle;
  let currentIndex = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let remainingToday = dailyRemaining;

  const emit = (type, payload = {}) => {
    onEvent({
      type,
      state,
      index: currentIndex,
      total: items.length,
      sent,
      failed,
      skipped,
      timestamp: Date.now(),
      ...payload,
    });
  };

  const isStopped = () => state === QUEUE_STATE.stopped;

  /** Blocks while paused, resolving as soon as the queue resumes or stops. */
  const waitWhilePaused = async () => {
    while (state === QUEUE_STATE.paused) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  async function run() {
    state = QUEUE_STATE.running;
    emit('started', { message: `Starting campaign — ${items.length} recipient(s) queued.` });

    for (currentIndex = 0; currentIndex < items.length; currentIndex += 1) {
      const item = items[currentIndex];

      await waitWhilePaused();
      if (isStopped()) break;

      if (remainingToday <= 0) {
        skipped = items.length - currentIndex;
        emit('limit-reached', {
          level: 'warn',
          message: `Daily sending limit reached. ${skipped} recipient(s) left for tomorrow.`,
        });
        break;
      }

      emit('sending', { item, level: 'info', message: `Sending to ${item.email}…` });

      let attempt = 0;
      let succeeded = false;
      let lastError = null;

      while (attempt <= maxRetries && !succeeded && !isStopped()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await sendFn(item, currentIndex);
          succeeded = true;
          sent += 1;
          remainingToday -= 1;
          emit('sent', {
            item,
            result,
            level: 'success',
            message: `Delivered to ${item.email}${attempt > 0 ? ` (retry ${attempt})` : ''}.`,
          });
        } catch (error) {
          lastError = error;
          const canRetry = attempt < maxRetries && error?.retryable !== false;

          if (canRetry) {
            attempt += 1;
            emit('retrying', {
              item,
              level: 'warn',
              message: `${item.email}: ${error.message} — retrying in 5s.`,
            });
            // eslint-disable-next-line no-await-in-loop
            await interruptibleWait(5000, { shouldAbort: isStopped });
          } else {
            break;
          }
        }
      }

      if (!succeeded && !isStopped()) {
        // An opt-out is a correct outcome, not a failure — the server refused
        // because the recipient asked not to be contacted. Counting it as a
        // failure makes a well-behaved campaign look broken and invites the
        // user to "fix" it by retrying, which is the opposite of the point.
        if (lastError?.kind === 'unsubscribed' || lastError?.skipped) {
          skipped += 1;
          emit('skipped', {
            item,
            level: 'warn',
            message: `${item.email} has unsubscribed — skipped.`,
          });
        } else {
          failed += 1;
          emit('failed', {
            item,
            error: lastError,
            level: 'error',
            message: `${item.email}: ${lastError?.message || 'Send failed.'}`,
          });
        }
      }

      const isLast = currentIndex === items.length - 1;
      if (isLast || isStopped()) continue;

      // Pace the next send.
      const delayMs = randomBetween(minDelay, maxDelay) * 1000;
      emit('waiting', { delaySeconds: Math.round(delayMs / 1000) });

      // eslint-disable-next-line no-await-in-loop
      await interruptibleWait(delayMs, {
        shouldAbort: () => isStopped() || state === QUEUE_STATE.paused,
        onTick: (secondsLeft) => emit('countdown', { secondsLeft, silent: true }),
      });
    }

    if (state !== QUEUE_STATE.stopped) state = QUEUE_STATE.done;

    emit('finished', {
      level: sent > 0 ? 'success' : 'info',
      message: `Campaign ${state === QUEUE_STATE.stopped ? 'stopped' : 'complete'} — ${sent} sent, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}.`,
    });
  }

  return {
    start() {
      if (state === QUEUE_STATE.running) return Promise.resolve();
      return run();
    },
    pause() {
      if (state !== QUEUE_STATE.running) return;
      state = QUEUE_STATE.paused;
      emit('paused', { level: 'warn', message: 'Campaign paused.' });
    },
    resume() {
      if (state !== QUEUE_STATE.paused) return;
      state = QUEUE_STATE.running;
      emit('resumed', { level: 'info', message: 'Campaign resumed.' });
    },
    stop() {
      if (state === QUEUE_STATE.done || state === QUEUE_STATE.stopped) return;
      state = QUEUE_STATE.stopped;
      emit('stopping', { level: 'warn', message: 'Stopping after the current send…' });
    },
    getState: () => ({ state, currentIndex, sent, failed, skipped }),
  };
}

/**
 * Estimates how long a campaign will take, for the "this will run for ~X"
 * warning before the user commits to a 200-lead send.
 */
export function estimateDuration(count, minDelaySeconds, maxDelaySeconds) {
  if (count <= 1) return { seconds: 0, label: 'a few seconds' };

  const gaps = count - 1;
  const averageDelay = (Number(minDelaySeconds) + Number(maxDelaySeconds)) / 2;
  // ~1.5s of round-trip per send on top of the configured gap.
  const seconds = Math.round(gaps * averageDelay + count * 1.5);

  return { seconds, label: formatDuration(seconds) };
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Removes duplicate leads by e-mail address (the only reliable key) and drops
 * entries without one. Sending the same person two copies is the fastest way
 * to get marked as spam.
 */
export function dedupeLeads(leads) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;

  for (const lead of leads) {
    const email = String(lead.email || '').trim().toLowerCase();
    if (!email) continue;
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    unique.push({ ...lead, email });
  }

  return { unique, duplicates };
}
