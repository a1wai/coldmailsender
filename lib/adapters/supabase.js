/**
 * lib/adapters/supabase.js
 * ---------------------------------------------------------------------------
 * Optional adapter for Supabase (free Postgres tier) — persists leads and
 * campaign history beyond a single browser.
 *
 * Talks to PostgREST directly over `fetch` rather than pulling in
 * `@supabase/supabase-js`, keeping the dependency list to exactly what the
 * spec calls for. Entirely optional: with no env vars set, `isSupabaseEnabled()`
 * is false and the app runs on LocalStorage alone.
 *
 * Run `supabase/schema.sql` in the Supabase SQL editor before first use.
 */

const LEADS_TABLE = 'leads';
const CAMPAIGNS_TABLE = 'campaign_events';
const UNSUBSCRIBES_TABLE = 'unsubscribes';

function getConfig(preferServiceRole = false) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) return null;

  // The service-role key bypasses row-level security, so it is only ever read
  // on the server. `typeof window` guards against it leaking into a bundle.
  const key = preferServiceRole && typeof window === 'undefined' && serviceKey ? serviceKey : anonKey;
  if (!key) return null;

  return { url: url.replace(/\/$/, ''), key };
}

export function isSupabaseEnabled() {
  return Boolean(getConfig());
}

async function request(path, { method = 'GET', body, headers = {}, serviceRole = false } = {}) {
  const config = getConfig(serviceRole);
  if (!config) throw new Error('Supabase is not configured.');

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 404 && detail.includes('does not exist')) {
      throw new Error('Supabase table not found — run supabase/schema.sql in the SQL editor first.');
    }
    throw new Error(`Supabase ${method} ${path} failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Inserts or updates leads, keyed on `email` so re-scraping the same site does
 * not create duplicates.
 */
export async function upsertLeads(leads, { serviceRole = false } = {}) {
  if (!Array.isArray(leads) || !leads.length) return [];

  const rows = leads
    .filter((lead) => lead.email)
    .map((lead) => ({
      email: String(lead.email).toLowerCase().trim(),
      name: lead.name || null,
      business: lead.business || null,
      website: lead.website || null,
      status: lead.status || 'new',
      industry: lead.industry || null,
      location: lead.location || null,
      custom_fields: lead.customFields || {},
      updated_at: new Date().toISOString(),
    }));

  if (!rows.length) return [];

  return request(`${LEADS_TABLE}?on_conflict=email`, {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    serviceRole,
  });
}

/** Fetches stored leads, newest first. */
export async function fetchLeads({ limit = 500, status, serviceRole = false } = {}) {
  const params = new URLSearchParams({
    select: '*',
    order: 'updated_at.desc',
    limit: String(Math.min(limit, 1000)),
  });

  if (status) params.set('status', `eq.${status}`);

  const rows = await request(`${LEADS_TABLE}?${params}`, { serviceRole });

  return (rows || []).map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name || '',
    business: row.business || '',
    website: row.website || '',
    status: row.status || 'new',
    industry: row.industry || '',
    location: row.location || '',
    customFields: row.custom_fields || {},
  }));
}

/**
 * Appends one campaign event (a send attempt and its outcome).
 * Best-effort: logging must never break an otherwise successful send, so this
 * swallows its own errors and reports via the return value.
 */
export async function logCampaignEvent(event, { serviceRole = true } = {}) {
  if (!isSupabaseEnabled()) return { ok: false, skipped: true };

  try {
    await request(CAMPAIGNS_TABLE, {
      method: 'POST',
      body: [
        {
          lead_email: String(event.email || '').toLowerCase(),
          template_id: event.templateId || null,
          template_name: event.templateName || null,
          subject: event.subject || null,
          status: event.status || 'unknown',
          error: event.error || null,
          message_id: event.messageId || null,
          sent_at: new Date().toISOString(),
        },
      ],
      headers: { Prefer: 'return=minimal' },
      serviceRole,
    });

    return { ok: true };
  } catch (error) {
    console.warn('[supabase] Could not log campaign event:', error.message);
    return { ok: false, error: error.message };
  }
}

/** Marks a lead's outreach status after a send attempt. */
export async function updateLeadStatus(email, status, { serviceRole = true } = {}) {
  if (!isSupabaseEnabled() || !email) return { ok: false, skipped: true };

  try {
    await request(`${LEADS_TABLE}?email=eq.${encodeURIComponent(String(email).toLowerCase())}`, {
      method: 'PATCH',
      body: { status, updated_at: new Date().toISOString() },
      headers: { Prefer: 'return=minimal' },
      serviceRole,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Returns every address already contacted, so a new campaign can exclude them.
 * Suppression is the difference between persistent follow-up and spamming.
 */
export async function fetchSuppressionList({ serviceRole = false } = {}) {
  if (!isSupabaseEnabled()) return new Set();

  try {
    const params = new URLSearchParams({
      select: 'lead_email',
      status: 'in.(sent,unsubscribed,bounced)',
      limit: '5000',
    });
    const rows = await request(`${CAMPAIGNS_TABLE}?${params}`, { serviceRole });
    return new Set((rows || []).map((row) => row.lead_email));
  } catch {
    return new Set();
  }
}

/**
 * Records an opt-out. Called from `/api/unsubscribe`, which is hit by mail
 * clients rather than by the app, so this is the only durable trace of the
 * request unless the sender is also notified by e-mail.
 *
 * `on_conflict=email` makes a repeat click idempotent rather than an error.
 */
export async function recordUnsubscribe({ email, sender = '', source = 'unknown' }, { serviceRole = true } = {}) {
  if (!isSupabaseEnabled() || !email) return { ok: false, skipped: true };

  await request(`${UNSUBSCRIBES_TABLE}?on_conflict=email`, {
    method: 'POST',
    body: [
      {
        email: String(email).toLowerCase().trim(),
        sender: sender || null,
        source,
        unsubscribed_at: new Date().toISOString(),
      },
    ],
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    serviceRole,
  });

  // Mirror onto the lead so the Send tab sees the status without a second query.
  await updateLeadStatus(email, 'unsubscribed').catch(() => {});

  return { ok: true };
}

/** Every address that has opted out. Checked server-side before each send. */
export async function fetchUnsubscribes({ serviceRole = true } = {}) {
  if (!isSupabaseEnabled()) return new Set();

  try {
    const rows = await request(`${UNSUBSCRIBES_TABLE}?select=email&limit=10000`, { serviceRole });
    return new Set((rows || []).map((row) => String(row.email).toLowerCase()));
  } catch (error) {
    console.warn('[supabase] Could not read the opt-out list:', error.message);
    return new Set();
  }
}

/**
 * True when this address has opted out.
 *
 * Queried per address rather than by pulling the whole list: the send route
 * runs once per recipient, and a targeted lookup stays fast as the list grows.
 * A failure returns `false` — a database outage must not silently halt a
 * campaign, and the browser holds its own copy of the list as a second guard.
 */
export async function isUnsubscribed(email, { serviceRole = true } = {}) {
  if (!isSupabaseEnabled() || !email) return false;

  try {
    const rows = await request(
      `${UNSUBSCRIBES_TABLE}?select=email&limit=1&email=eq.${encodeURIComponent(String(email).toLowerCase().trim())}`,
      { serviceRole },
    );
    return Boolean(rows?.length);
  } catch {
    return false;
  }
}
