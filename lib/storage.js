'use client';

/**
 * lib/storage.js
 * ---------------------------------------------------------------------------
 * Zero-cost persistence layer: browser storage + JSON import/export.
 *
 * Everything here is SSR-safe — Next pre-renders these components on the
 * server where `window` does not exist, so every access is guarded and the
 * hook hydrates from storage in an effect rather than during render (reading
 * storage during render causes a hydration mismatch).
 *
 * Storage choice is deliberate:
 *   - Leads, templates, settings → localStorage (survives a browser restart).
 *   - SMTP credentials          → sessionStorage by default, so an app password
 *                                 is gone when the tab closes. Users can opt in
 *                                 to localStorage explicitly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'coldmail:v1:';

export const STORAGE_KEYS = {
  leads: `${PREFIX}leads`,
  templates: `${PREFIX}templates`,
  attachments: `${PREFIX}attachments`,
  reelLinks: `${PREFIX}reelLinks`,
  campaign: `${PREFIX}campaign`,
  scraper: `${PREFIX}scraper`,
  smtp: `${PREFIX}smtp`,
  smtpRemember: `${PREFIX}smtpRemember`,
  sendCounter: `${PREFIX}sendCounter`,
};

function getStore(kind) {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    // Private-mode Safari and hardened browser profiles throw on access.
    return null;
  }
}

export function readStorage(key, fallback = null, kind = 'local') {
  const store = getStore(kind);
  if (!store) return fallback;

  try {
    const raw = store.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeStorage(key, value, kind = 'local') {
  const store = getStore(kind);
  if (!store) return false;

  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    // QuotaExceededError: usually base64 attachments pushed past the ~5 MB cap.
    console.warn(`[storage] Could not persist "${key}":`, error?.name || error);
    return false;
  }
}

export function removeStorage(key, kind = 'local') {
  const store = getStore(kind);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}

/**
 * `useState` that persists. Returns the usual `[value, setValue]` pair plus a
 * `hydrated` flag so components can avoid flashing default content before the
 * stored value has loaded.
 *
 * @param {string} key
 * @param {*} initialValue
 * @param {{ kind?: 'local'|'session' }} [options]
 * @returns {[*, Function, boolean]}
 */
export function useStoredState(key, initialValue, options = {}) {
  const kind = options.kind || 'local';
  const [value, setValue] = useState(initialValue);
  const [hydrated, setHydrated] = useState(false);
  const keyRef = useRef(key);
  keyRef.current = key;

  // Load once on mount — never during render.
  useEffect(() => {
    const stored = readStorage(key, undefined, kind);
    if (stored !== undefined) setValue(stored);
    setHydrated(true);
    // Re-hydrating on key change is intentional; `kind` never changes at runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on change, but not before hydration — otherwise the initial
  // default would overwrite the stored value on first paint.
  useEffect(() => {
    if (!hydrated) return;
    writeStorage(keyRef.current, value, kind);
  }, [value, hydrated, kind]);

  const reset = useCallback(() => {
    removeStorage(keyRef.current, kind);
    setValue(initialValue);
    // `initialValue` is a literal at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return [value, setValue, hydrated, reset];
}

// ---------------------------------------------------------------------------
// Daily send counter — local guard against Gmail's 500/day cap
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** `{ date, count }` for the current day, resetting automatically at midnight. */
export function readSendCounter() {
  const stored = readStorage(STORAGE_KEYS.sendCounter, null);
  if (!stored || stored.date !== today()) return { date: today(), count: 0 };
  return stored;
}

export function incrementSendCounter(by = 1) {
  const current = readSendCounter();
  const next = { date: current.date, count: current.count + by };
  writeStorage(STORAGE_KEYS.sendCounter, next);
  return next;
}

export function resetSendCounter() {
  const next = { date: today(), count: 0 };
  writeStorage(STORAGE_KEYS.sendCounter, next);
  return next;
}

// ---------------------------------------------------------------------------
// JSON import / export
// ---------------------------------------------------------------------------

/** Triggers a browser download of `data` as prettified JSON. */
export function downloadJson(data, filename) {
  if (typeof window === 'undefined') return;

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoking immediately can cancel the download in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Triggers a browser download of rows as a spreadsheet-friendly CSV. */
export function downloadCsv(rows, filename, columns) {
  if (typeof window === 'undefined' || !rows.length) return;

  const headers = columns || Object.keys(rows[0]);
  const escapeCell = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    // Quote whenever the cell contains a delimiter, quote, or newline.
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(',')),
  ].join('\r\n');

  // The BOM makes Excel read the file as UTF-8 instead of mangling accents.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads a user-selected `.json` File and resolves the parsed contents. */
export function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)));
      } catch {
        reject(new Error(`${file.name} is not valid JSON.`));
      }
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

/** Reads a File as a base64 data URL — used by the attachment manager. */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** One bundle containing everything — the "back up my whole workspace" button. */
export function buildBackup() {
  return {
    format: 'coldmailsender-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    leads: readStorage(STORAGE_KEYS.leads, []),
    templates: readStorage(STORAGE_KEYS.templates, []),
    reelLinks: readStorage(STORAGE_KEYS.reelLinks, []),
    campaign: readStorage(STORAGE_KEYS.campaign, {}),
    scraper: readStorage(STORAGE_KEYS.scraper, {}),
    // Credentials and attachment binaries are deliberately excluded: a backup
    // file gets e-mailed around, and an app password must never ride along.
  };
}

/** Validates and applies a backup produced by `buildBackup`. */
export function restoreBackup(payload) {
  if (!payload || payload.format !== 'coldmailsender-backup') {
    throw new Error('That file is not a Cold Mail Sender backup.');
  }

  const restored = [];

  if (Array.isArray(payload.leads)) {
    writeStorage(STORAGE_KEYS.leads, payload.leads);
    restored.push(`${payload.leads.length} leads`);
  }
  if (Array.isArray(payload.templates)) {
    writeStorage(STORAGE_KEYS.templates, payload.templates);
    restored.push(`${payload.templates.length} templates`);
  }
  if (Array.isArray(payload.reelLinks)) {
    writeStorage(STORAGE_KEYS.reelLinks, payload.reelLinks);
    restored.push(`${payload.reelLinks.length} links`);
  }
  if (payload.campaign && typeof payload.campaign === 'object') {
    writeStorage(STORAGE_KEYS.campaign, payload.campaign);
  }
  if (payload.scraper && typeof payload.scraper === 'object') {
    writeStorage(STORAGE_KEYS.scraper, payload.scraper);
  }

  return restored;
}
