-- Wavly WiFi — captive portal & hotspot manager
-- All tables are namespaced with wavly_ so this migration is safe to apply
-- to an existing Supabase project that already hosts other applications.
-- Run once in the Supabase SQL Editor (or via the management API).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Hotspot configuration (single row per location)
-- ---------------------------------------------------------------------------
create table if not exists public.wavly_hotspot (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null default 'Wavly WiFi',
  ssid                     text not null default 'WAVLY-GUEST',
  location                 text not null default '',
  currency                 text not null default 'GHS',
  portal_title             text not null default 'Welcome to Wavly WiFi',
  welcome_message          text not null default '',
  tos_text                 text not null default '',
  max_download_mbps        integer not null default 30,
  max_upload_mbps          integer not null default 10,
  session_timeout_minutes  integer not null default 15,
  is_active                boolean not null default true,
  updated_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Plans / passes
-- ---------------------------------------------------------------------------
create table if not exists public.wavly_plans (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  description       text not null default '',
  price             numeric(10,2) not null default 0,
  duration_minutes  integer not null default 60,
  data_limit_mb     integer,                 -- NULL = unlimited
  speed_mbps        integer not null default 10,
  device_limit      integer not null default 1,
  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  accent            text not null default 'violet',
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Voucher codes
-- ---------------------------------------------------------------------------
create table if not exists public.wavly_vouchers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  plan_id     uuid not null references public.wavly_plans(id) on delete restrict,
  status      text not null default 'active'
              check (status in ('active','used','revoked','expired')),
  batch_id    uuid,
  note        text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  used_at     timestamptz
);
create index if not exists wavly_vouchers_status_idx on public.wavly_vouchers (status);
create index if not exists wavly_vouchers_created_idx on public.wavly_vouchers (created_at desc);

-- ---------------------------------------------------------------------------
-- Devices seen on the network
-- ---------------------------------------------------------------------------
create table if not exists public.wavly_devices (
  id             uuid primary key default gen_random_uuid(),
  mac            text not null unique,
  vendor         text not null default 'Guest device',
  label          text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Connection sessions
-- ---------------------------------------------------------------------------
create table if not exists public.wavly_sessions (
  id           uuid primary key default gen_random_uuid(),
  voucher_id   uuid references public.wavly_vouchers(id) on delete set null,
  device_id    uuid not null references public.wavly_devices(id) on delete cascade,
  plan_id      uuid not null references public.wavly_plans(id) on delete restrict,
  started_at   timestamptz not null default now(),
  expires_at   timestamptz,
  ended_at     timestamptz,
  status       text not null default 'active'
               check (status in ('active','ended','expired')),
  bytes_used   bigint not null default 0,
  ip           text
);
create index if not exists wavly_sessions_status_idx on public.wavly_sessions (status);
create index if not exists wavly_sessions_started_idx on public.wavly_sessions (started_at desc);

-- ---------------------------------------------------------------------------
-- Activity / audit log
-- ---------------------------------------------------------------------------
create table if not exists public.wavly_events (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  message     text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists wavly_events_created_idx on public.wavly_events (created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- The Next.js server uses the service-role key, which bypasses RLS.
-- Only public, read-only configuration is exposed to anon clients.
-- ---------------------------------------------------------------------------
alter table public.wavly_hotspot  enable row level security;
alter table public.wavly_plans    enable row level security;
alter table public.wavly_vouchers enable row level security;
alter table public.wavly_devices  enable row level security;
alter table public.wavly_sessions enable row level security;
alter table public.wavly_events   enable row level security;

drop policy if exists "wavly_public_read_hotspot" on public.wavly_hotspot;
create policy "wavly_public_read_hotspot"
  on public.wavly_hotspot for select to anon, authenticated using (true);

drop policy if exists "wavly_public_read_plans" on public.wavly_plans;
create policy "wavly_public_read_plans"
  on public.wavly_plans for select to anon, authenticated using (true);
