-- ============================================================================
-- Cold Email Sender — optional Supabase schema
-- ----------------------------------------------------------------------------
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- if you want leads and campaign history to persist beyond a single browser.
--
-- The app works perfectly well without it — LocalStorage plus JSON export is
-- the zero-setup default. This is only for multi-device or multi-user use.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Leads
-- ----------------------------------------------------------------------------
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text,
  business      text,
  website       text,
  status        text not null default 'new',
  industry      text,
  location      text,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One row per address. The adapter upserts on this constraint, so
  -- re-scraping a site updates the existing lead instead of duplicating it.
  constraint leads_email_unique unique (email),

  constraint leads_status_check check (
    status in ('new', 'no-email', 'queued', 'sending', 'sent', 'failed', 'skipped', 'unsubscribed', 'bounced')
  )
);

create index if not exists leads_status_idx     on public.leads (status);
create index if not exists leads_updated_at_idx on public.leads (updated_at desc);


-- ----------------------------------------------------------------------------
-- Campaign events — one row per send attempt
-- ----------------------------------------------------------------------------
create table if not exists public.campaign_events (
  id            uuid primary key default gen_random_uuid(),
  lead_email    text not null,
  template_id   text,
  template_name text,
  subject       text,
  status        text not null,
  error         text,
  message_id    text,
  sent_at       timestamptz not null default now(),

  constraint campaign_events_status_check check (
    status in ('sent', 'failed', 'skipped', 'unsubscribed', 'bounced', 'unknown')
  )
);

create index if not exists campaign_events_email_idx   on public.campaign_events (lead_email);
create index if not exists campaign_events_sent_at_idx on public.campaign_events (sent_at desc);
create index if not exists campaign_events_status_idx  on public.campaign_events (status);


-- ----------------------------------------------------------------------------
-- Opt-outs — written by /api/unsubscribe, read before every send
--
-- Separate from campaign_events on purpose. An opt-out has to outlive the
-- campaign that caused it: deleting send history must never resurrect somebody
-- who asked to be left alone. `email` is the primary key so a repeated click on
-- the same unsubscribe link is idempotent rather than an error.
-- ----------------------------------------------------------------------------
create table if not exists public.unsubscribes (
  email           text primary key,
  sender          text,
  source          text,
  unsubscribed_at timestamptz not null default now()
);

create index if not exists unsubscribes_at_idx on public.unsubscribes (unsubscribed_at desc);


-- ----------------------------------------------------------------------------
-- Keep `updated_at` honest
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at
  before update on public.leads
  for each row
  execute function public.touch_updated_at();


-- ----------------------------------------------------------------------------
-- Row-level security
-- ----------------------------------------------------------------------------
-- RLS is enabled with NO permissive policies, which denies the anon key
-- outright. Writes therefore go through SUPABASE_SERVICE_ROLE_KEY, which is
-- read only on the server and bypasses RLS.
--
-- This matters: your Supabase URL and anon key ship to the browser inside any
-- NEXT_PUBLIC_ variable. Without RLS, anyone who opens devtools on your
-- deployment can read and delete your entire lead list.
--
-- If you later add Supabase Auth and want per-user access, replace this with
-- policies scoped to auth.uid() and add an owner column to both tables.
-- ----------------------------------------------------------------------------
alter table public.leads           enable row level security;
alter table public.campaign_events enable row level security;
alter table public.unsubscribes    enable row level security;

-- Drop any permissive policy left over from an earlier run.
drop policy if exists leads_anon_all           on public.leads;
drop policy if exists campaign_events_anon_all on public.campaign_events;
drop policy if exists unsubscribes_anon_all    on public.unsubscribes;


-- ----------------------------------------------------------------------------
-- Handy views
-- ----------------------------------------------------------------------------

-- Everyone already contacted — exclude these from new campaigns.
create or replace view public.suppression_list as
select distinct lead_email
from public.campaign_events
where status in ('sent', 'unsubscribed', 'bounced');

-- Daily send volume, for keeping an eye on the Gmail quota over time.
create or replace view public.daily_send_stats as
select
  date_trunc('day', sent_at)::date            as day,
  count(*) filter (where status = 'sent')     as sent,
  count(*) filter (where status = 'failed')   as failed,
  count(*)                                    as total
from public.campaign_events
group by 1
order by 1 desc;
