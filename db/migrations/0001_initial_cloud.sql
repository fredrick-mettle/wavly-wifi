-- ============================================================================
--  Wavly WiFi — Hotspot billing & captive portal
--  Migration 0001 — CLOUD database (Supabase PostgreSQL)
-- ----------------------------------------------------------------------------
--  This is the AUTHORITATIVE store for all business data: customers, plans,
--  subscriptions, orders, payments, vouchers, resellers, messaging, audit.
--
--  The RADIUS-facing tables (radcheck / radacct / nas ...) are NOT here.
--  They live in a separate local PostgreSQL on the on-site edge node —
--  see db/migrations/0002_edge_radius.sql and docs/01-architecture.md.
--
--  Conventions
--  ------------
--  * Money is ALWAYS an integer number of PESEWAS in a bigint column.
--    Never numeric-with-float, never cedis. Paystack also charges in pesewas,
--    so no rounding ever crosses the payment boundary. `_pesewas` suffix.
--  * Timestamps are timestamptz. Render in Africa/Accra (GMT+0, no DST).
--  * Phone numbers: `*_e164` = '+233244123456' (unique key, Arkesel format),
--    `*_local` = '0244123456' (Paystack MoMo format, what humans type).
--  * Statuses are `text` + CHECK, not native enums. ALTER TYPE ... ADD VALUE
--    cannot run inside a transaction block on PG < 12 semantics that many
--    migration runners assume, and CHECK constraints are trivially amendable.
--  * Every mutable row carries updated_at (trigger-maintained) and most carry
--    `version` for optimistic locking — the edge sync agent needs it.
--  * Soft delete (`deleted_at`) only where a hard delete would destroy the
--    audit trail of money movement: users, plans, resellers.
--
--  Requires PostgreSQL 13+ (gen_random_uuid is built in from 13).
-- ============================================================================

begin;

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email

-- ============================================================================
--  0. Helper functions
-- ============================================================================

-- updated_at maintenance ------------------------------------------------------------
create or replace function app_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app_touch_updated_at() is
  'BEFORE UPDATE trigger body: stamps updated_at = now().';

-- Ghana phone normalisation ---------------------------------------------------------
create or replace function app_normalize_gh_phone(raw text) returns text
language plpgsql immutable as $$
declare
  digits text;
begin
  if raw is null then return null; end if;
  digits := regexp_replace(raw, '[^0-9]', '', 'g');

  if left(digits, 5) = '00233' then
    digits := '233' || substring(digits from 6);
  end if;
  -- 0244123456 -> 233244123456
  if left(digits, 1) = '0' and length(digits) = 10 then
    digits := '233' || substring(digits from 2);
  end if;
  -- 244123456 (9 digits, dropped leading 0) -> 233244123456
  if length(digits) = 9 and left(digits, 1) = '2' then
    digits := '233' || digits;
  end if;

  if length(digits) <> 12 or left(digits, 3) <> '233' then
    return null;  -- caller must reject
  end if;
  return '+' || digits;
end;
$$;

comment on function app_normalize_gh_phone(text) is
  'Accepts 0244123456 / +233244123456 / 233244123456 / 00233244123456 / "024 412 3456". Returns E.164 or NULL if not a valid Ghana number.';

create or replace function app_gh_phone_local(e164 text) returns text
language sql immutable as $$
  select case when e164 like '+233%' and length(e164) = 13
              then '0' || right(e164, 9) end;
$$;

comment on function app_gh_phone_local(text) is
  'E.164 -> the 10-digit local form Paystack Mobile Money expects.';

-- Mobile network detection ----------------------------------------------------------
-- Ghanaian mobile prefixes. This is a HINT only: Ghana has had mobile number
-- portability since 2021, so a 024 number can live on Telecel. The app stores
-- both the detected and the operator-confirmed network. settings key
-- `payments.momo_prefix_map` overrides this map without a migration.
create or replace function app_detect_momo_network(e164 text) returns text
language sql immutable as $$
  select case
    when e164 ~ '^\+233(24|25|53|54|55|59)' then 'mtn'
    when e164 ~ '^\+233(20|50)'              then 'telecel'
    when e164 ~ '^\+233(26|27|56|57)'        then 'airteltigo'
    else null
  end;
$$;

comment on function app_detect_momo_network(text) is
  'Best-effort network from the MSISDN prefix: mtn / telecel / airteltigo / NULL. Portability means this can be wrong; confirm via Paystack authorization.bank on success.';

-- Display helpers -------------------------------------------------------------------
create or replace function app_ghs(pesewas bigint) returns text
language sql immutable as $$
  select 'GH' || chr(162) || ' ' ||
         to_char(coalesce(pesewas, 0) / 100.0, 'FM999,999,990.00');
$$;

comment on function app_ghs(bigint) is 'Pesewas -> "GH¢ 70.00". For admin UI and CSV exports only; never for arithmetic.';

create or replace function app_format_bytes(n bigint) returns text
language sql immutable as $$
  select case
    when n is null          then null
    when n < 1024           then n || ' B'
    when n < 1048576        then round(n / 1024.0)::bigint || ' KB'
    when n < 1073741824     then round(n / 1048576.0, 1) || ' MB'
    else round(n / 1073741824.0, 2) || ' GB'
  end;
$$;

-- MAC normalisation -----------------------------------------------------------------
create or replace function app_normalize_mac(raw text) returns text
language plpgsql immutable as $$
declare
  hex text;
begin
  if raw is null then return null; end if;
  hex := upper(regexp_replace(raw, '[^0-9a-fA-F]', '', 'g'));
  if length(hex) <> 12 then return null; end if;
  return substring(hex from 1 for 2) || ':' || substring(hex from 3 for 2) || ':' ||
         substring(hex from 5 for 2) || ':' || substring(hex from 7 for 2) || ':' ||
         substring(hex from 9 for 2) || ':' || substring(hex from 11 for 2);
end;
$$;

comment on function app_normalize_mac(text) is
  'Any spelling -> upper-case colon-separated AA:BB:CC:DD:EE:FF, or NULL. MikroTik sends Calling-Station-Id as aa:bb:cc:dd:ee:ff; normalise on BOTH sides before comparing.';

-- Voucher code check digit ----------------------------------------------------------
-- Crockford Base32 alphabet (no I, L, O, U) so codes can be read aloud over the
-- phone in a noisy shop and typed without ambiguity. Last character is a
-- mod-31 check digit, which catches the two most common errors: a wrong
-- character and a transposition of adjacent characters.
create or replace function app_voucher_code_valid(code text) returns boolean
language plpgsql immutable as $$
declare
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  digits   text;
  total    int := 0;
  weight   int;
  i        int;
  pos      int;
begin
  digits := upper(regexp_replace(coalesce(code, ''), '[^0-9A-Z]', '', 'g'));
  if length(digits) < 2 then return false; end if;

  for i in 1..length(digits) loop
    pos := strpos(alphabet, substring(digits from i for 1));
    if pos = 0 then return false; end if;          -- I, L, O, U or junk
    weight := 1 + ((length(digits) - i) % 2);      -- alternating 1,2,1,2...
    total := total + ((pos - 1) * weight);
  end loop;

  return (total % 31) = 0;
end;
$$;

comment on function app_voucher_code_valid(text) is
  'Validates the mod-31 check digit on a voucher code. Reject typos at the redemption endpoint BEFORE hitting the DB.';

create or replace function app_voucher_check_digit(body text) returns text
language plpgsql immutable as $$
declare
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
begin
  -- Try every alphabet character; exactly one makes the whole code valid.
  for i in 1..31 loop
    candidate := upper(body) || substring(alphabet from i for 1);
    if app_voucher_code_valid(candidate) then return candidate; end if;
  end loop;
  return null;  -- unreachable: mod 31 over a 31-char alphabet always resolves
end;
$$;


-- ============================================================================
--  1. SITES, POLICY, CONFIG
-- ============================================================================

create table sites (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,                 -- 'nkawie-01'
  name               text not null,
  town               text not null,
  region             text not null default 'Greater Accra',
  country            char(2) not null default 'GH',
  timezone           text not null default 'Africa/Accra',
  latitude           numeric(9,6),
  longitude          numeric(9,6),
  support_phone_e164 text,
  support_hours      text,                                 -- free text for the portal footer
  is_active          boolean not null default true,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sites_support_phone_e164_ck check (support_phone_e164 is null or support_phone_e164 ~ '^\+233[0-9]{9}$'),
  constraint sites_code_ck check (code ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);
create trigger sites_touch before update on sites for each row execute function app_touch_updated_at();

comment on table sites is
  'One row per physical hotspot location. The whole schema is site-scoped so a second village can be added without a redesign — that is the "design so it can scale" hook. Start with exactly one row.';


create table privacy_notices (
  id            uuid primary key default gen_random_uuid(),
  version       int  not null unique,
  locale        text not null default 'en-GH',
  title         text not null,
  body_markdown text not null,
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  published_at   timestamptz,
  created_by_admin_id uuid,          -- FK added below (admin_users is created next)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint privacy_notices_version_ck check (version > 0)
);
create trigger privacy_notices_touch before update on privacy_notices for each row execute function app_touch_updated_at();

comment on table privacy_notices is
  'Versioned privacy notice. Ghana Data Protection Act 2012 (Act 843) s.20 requires the data subject to be informed at collection. Versioning means we can prove WHICH notice a customer accepted, and users.privacy_notice_id points at it.';


create table settings (
  key               text primary key,                      -- dotted: 'reminders.expiry_lead_days'
  value             jsonb not null,
  value_type        text not null default 'string'
                    check (value_type in ('string','number','boolean','json','array')),
  category          text not null default 'general'
                    check (category in ('general','branding','payments','sms','radius','network',
                                        'security','billing','resellers','operations','legal')),
  description       text,
  is_secret         boolean not null default false,
  is_public         boolean not null default false,        -- safe to expose to portal templates
  editable_by       text not null default 'admin'
                    check (editable_by in ('admin','system','env')),  -- 'env' = read-only mirror of environment
  updated_by_admin_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger settings_touch before update on settings for each row execute function app_touch_updated_at();

comment on table settings is
  'Runtime-configurable business knobs, editable from the admin dashboard without a deploy. When is_secret = true the value is sealed with libsodium secretbox using SETTINGS_ENC_KEY before storage and never returned by any API. See db/seed/0001_core_defaults.sql for the full key list.';


-- ============================================================================
--  2. STAFF / MACHINE IDENTITY
-- ============================================================================

create table admin_users (
  id                  uuid primary key default gen_random_uuid(),
  email               citext not null unique,
  full_name           text not null,
  password_hash       text not null,                       -- argon2id, never bcrypt-cost-10
  role                text not null default 'support'
                      check (role in ('owner','manager','support','reseller')),
  status              text not null default 'pending'
                      check (status in ('pending','active','suspended','terminated')),
  totp_enabled        boolean not null default false,      -- 2FA required before first login completes
  totp_secret_cipher  text,                                -- sealed with ADMIN_TOTP_ENC_KEY
  totp_confirmed_at   timestamptz,
  must_rotate_password boolean not null default true,
  failed_login_count  int  not null default 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  last_login_ip       inet,
  password_changed_at timestamptz,
  site_id             uuid references sites(id) on delete set null,
  phone_e164          text,                                -- optional; only if SMS 2FA recovery is wanted
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint admin_users_phone_e164_ck check (phone_e164 is null or phone_e164 ~ '^\+233[0-9]{9}$')
);
create trigger admin_users_touch before update on admin_users for each row execute function app_touch_updated_at();

comment on table admin_users is
  'Human operators of the dashboard. role=owner can do anything including money movement and refunds; manager cannot delete data; support can look up and extend but not refund; reseller sees only its own voucher book. 2FA (TOTP) is enforced by middleware for every role — see docs/08-security.md.';

create index admin_users_status_idx on admin_users (status) where deleted_at is null;


create table admin_recovery_codes (
  id             uuid primary key default gen_random_uuid(),
  admin_user_id  uuid not null references admin_users(id) on delete cascade,
  code_hash      text not null,                            -- sha256 of the printed code
  used_at        timestamptz,
  created_at     timestamptz not null default now(),
  constraint admin_recovery_codes_unique unique (admin_user_id, code_hash)
);

comment on table admin_recovery_codes is
  'One-shot TOTP backup codes, hashed. Ten are minted when 2FA is enrolled; the plaintext is shown exactly once.';


alter table privacy_notices
  add constraint privacy_notices_created_by_fk
  foreign key (created_by_admin_id) references admin_users(id) on delete set null;
alter table settings
  add constraint settings_updated_by_fk
  foreign key (updated_by_admin_id) references admin_users(id) on delete set null;


create table api_tokens (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,                        -- 'nkawie-edge-01'
  subject_type       text not null
                     check (subject_type in ('edge_node','reseller','integration','script')),
  subject_id         uuid,                                 -- resellers.id / nas_devices.id (polymorphic, no FK)
  token_prefix       text not null,                        -- first 8 chars, shown in the UI to identify a key
  token_hash         text not null unique,                 -- sha256(token); the token itself is shown once
  scopes             text[] not null default '{}',
  status             text not null default 'active'
                     check (status in ('active','revoked','expired')),
  expires_at         timestamptz,
  last_used_at       timestamptz,
  last_used_ip       inet,
  use_count          bigint not null default 0,
  rotate_from_id     uuid references api_tokens(id) on delete set null,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_by_admin_id uuid references admin_users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger api_tokens_touch before update on api_tokens for each row execute function app_touch_updated_at();
create index api_tokens_subject_idx on api_tokens (subject_type, subject_id) where status = 'active';

comment on table api_tokens is
  'Bearer credentials for machine callers. The on-site edge node uses one of these (scopes: radius:sync, usage:push, config:pull) to authenticate to the cloud over its OUTBOUND Starlink connection — no inbound port is ever opened. Scopes are a plain text[] checked in middleware.';


create table resellers (
  id                     uuid primary key default gen_random_uuid(),
  admin_user_id          uuid references admin_users(id) on delete set null,   -- optional dashboard login
  business_name          text not null,
  contact_name           text not null,
  phone_e164             text not null unique,
  phone_local            text not null,
  town                   text,
  region                 text,
  commission_model       text not null default 'percent'
                         check (commission_model in ('percent','fixed','margin')),
  commission_percent     numeric(5,2) not null default 10.00
                         check (commission_percent >= 0 and commission_percent <= 100),
  commission_fixed_pesewas bigint not null default 0 check (commission_fixed_pesewas >= 0),
  wallet_balance_pesewas bigint not null default 0,
  payout_phone_e164      text,
  payout_network         text check (payout_network is null or payout_network in ('mtn','telecel','airteltigo')),
  status                 text not null default 'pending'
                         check (status in ('pending','active','suspended','terminated')),
  site_id                uuid references sites(id) on delete set null,
  approved_by_admin_id   uuid references admin_users(id) on delete set null,
  approved_at            timestamptz,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  constraint resellers_phone_e164_ck check (phone_e164 ~ '^\+233[0-9]{9}$')
);
create trigger resellers_touch before update on resellers for each row execute function app_touch_updated_at();

comment on table resellers is
  'PHASE 2 — agents who buy voucher books at wholesale and retail them for commission. commission_model=margin means they pay us unit_cost_pesewas and keep the difference (see voucher_batches.unit_cost_pesewas); percent/fixed accrue into wallet_balance_pesewas via reseller_ledger. Table is created now because vouchers and orders already need the FK.';


-- ============================================================================
--  3. CUSTOMERS
-- ============================================================================

create table users (
  id                    uuid primary key default gen_random_uuid(),
  username              text not null unique,               -- RADIUS User-Name; defaults to phone_local
  phone_e164            text not null unique,
  phone_local           text not null unique,
  phone_verified_at     timestamptz,
  momo_network_detected text check (momo_network_detected is null or momo_network_detected in ('mtn','telecel','airteltigo')),
  momo_network_confirmed text check (momo_network_confirmed is null or momo_network_confirmed in ('mtn','telecel','airteltigo')),
  first_name            text,                               -- MINIMAL PII: one optional name field
  email                 citext,                             -- optional; only if the customer volunteers it
  password_hash         text,                               -- NULL for voucher-only customers (they need none)
  status                text not null default 'active'
                        check (status in ('active','suspended','banned','self_excluded')),
  status_reason         text,
  status_changed_at     timestamptz,
  status_changed_by     uuid references admin_users(id) on delete set null,
  home_site_id          uuid references sites(id) on delete set null,
  active_subscription_id uuid,                              -- FK added below (circular with subscriptions)
  wallet_pesewas        bigint not null default 0 check (wallet_pesewas >= 0),
  total_paid_pesewas    bigint not null default 0,
  total_bytes_used      bigint not null default 0,
  lifetime_sessions     bigint not null default 0,
  preferred_language    text not null default 'en'
                        check (preferred_language in ('en','tw')),               -- English / Twi
  privacy_notice_id     uuid references privacy_notices(id) on delete set null,
  privacy_accepted_at   timestamptz,
  marketing_consent     boolean not null default false,     -- separate, opt-in, revocable
  marketing_consent_at  timestamptz,
  mac_binding_enabled   boolean not null default false,     -- per-user override of the plan default
  max_devices_override  int,                                -- NULL = inherit from plan
  first_seen_at         timestamptz not null default now(),
  first_seen_ip         inet,
  last_login_at         timestamptz,
  referred_by_reseller_id uuid references resellers(id) on delete set null,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,                        -- erasure request under Act 843 s.32
  constraint users_username_ck check (username ~ '^[a-z0-9._-]{3,32}$'),
  constraint users_phone_e164_ck check (phone_e164 ~ '^\+233[0-9]{9}$'),
  constraint users_phone_local_ck check (phone_local ~ '^0[0-9]{9}$'),
  constraint users_max_devices_override_ck check (max_devices_override is null or (max_devices_override between 1 and 20))
);
create trigger users_touch before update on users for each row execute function app_touch_updated_at();

create index users_status_idx           on users (status) where deleted_at is null;
create index users_home_site_idx        on users (home_site_id) where deleted_at is null;
create index users_created_at_idx       on users using brin (created_at);
create index users_total_paid_idx       on users (total_paid_pesewas desc) where deleted_at is null;   -- "top users"

comment on table users is
  'Customer identity. Deliberately minimal under the Ghana Data Protection Act: phone number (required — it is the account key AND the payment instrument), one optional first name, no address, no ID document, no date of birth. Erasure is a soft delete plus a purge job that keeps only the aggregated money rows required by law. username defaults to phone_local so the Wi-Fi login is the number the customer already knows.';


create table wallet_entries (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  entry_type            text not null
                        check (entry_type in ('refund_credit','compensation','promo_credit','manual_adjustment',
                                              'wallet_debit','expiry_forfeit','reversal')),
  amount_pesewas        bigint not null,                    -- signed; positive = credit
  balance_after_pesewas bigint not null,
  related_type          text,                               -- polymorphic: order / refund / subscription / voucher
  related_id            text,
  description           text not null,
  expires_at            timestamptz,                        -- promo credit can expire
  created_by_admin_id   uuid references admin_users(id) on delete set null,
  created_at            timestamptz not null default now()
);
create index wallet_entries_user_idx  on wallet_entries (user_id, created_at desc);
create index wallet_entries_type_idx  on wallet_entries (entry_type, created_at desc);

comment on table wallet_entries is
  'Append-only credit ledger behind users.wallet_pesewas. This exists because in Ghana the practical remedy for a failed activation or a duplicate MoMo charge is often wallet credit, not a Paystack reversal — operator refunds can take days. Every balance change is one row here, so a dispute is answerable with a query. balance_after_pesewas makes gaps and double-applies visible.';


create table user_devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  mac_address    text not null,                             -- app_normalize_mac() output
  label          text,                                      -- "Ama's phone"
  device_type    text check (device_type is null or device_type in ('phone','tablet','laptop','tv','console','other')),
  is_bound       boolean not null default false,            -- bound device: ONLY this MAC may authenticate
  status         text not null default 'pending'
                 check (status in ('pending','allowed','blocked')),
  first_seen_at  timestamptz not null default now(),
  first_seen_ip  inet,
  last_seen_at   timestamptz,
  last_seen_ip   inet,
  last_user_agent text,
  bytes_used_total bigint not null default 0,
  blocked_at     timestamptz,
  blocked_reason text,
  approved_by_admin_id uuid references admin_users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint user_devices_unique unique (user_id, mac_address),
  constraint user_devices_mac_ck check (mac_address ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$')
);
create trigger user_devices_touch before update on user_devices for each row execute function app_touch_updated_at();
create index user_devices_mac_idx on user_devices (mac_address);

comment on table user_devices is
  'Registered devices per account. Two distinct controls live here: (1) the SIMULTANEOUS limit — enforced by FreeRADIUS via the Simultaneous-Use reply attribute derived from plans.max_simultaneous_devices; (2) the REGISTERED/bound limit — plans.max_registered_devices rows here, and when is_bound = true the edge FreeRADIUS policy rejects an Access-Request whose Calling-Station-Id is not in this table, which is what actually stops account sharing. A MAC seen once is auto-registered as pending until the customer or an admin allows it.';


create table sessions (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,                        -- sha256 of the opaque cookie value
  subject_type text not null check (subject_type in ('customer','admin','reseller')),
  subject_id   uuid not null,                               -- polymorphic; no FK on purpose
  site_id      uuid references sites(id) on delete set null,
  ip           inet,
  user_agent   text,
  is_current   boolean not null default true,               -- set false on cookie rotation
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  revoke_reason text
);
create index sessions_subject_idx on sessions (subject_type, subject_id) where revoked_at is null;
create index sessions_expiry_idx  on sessions (expires_at) where revoked_at is null;

comment on table sessions is
  'Server-side session store for BOTH the customer portal and the admin dashboard. Opaque random cookie value, only its sha256 stored, HttpOnly + Secure + SameSite=Lax. Customer sessions are short (2h sliding) because a shared family phone is the common case; admin sessions are 8h absolute and die on password or TOTP change. Storing them in the DB rather than a signed JWT gives us a "log out everywhere" button and revocation on ban — which matters when you suspend an account for abuse.';


create table phone_verifications (
  id            uuid primary key default gen_random_uuid(),
  phone_e164    text not null,
  phone_local   text not null,
  purpose       text not null
                check (purpose in ('signup','login','phone_change','password_reset','voucher_redemption','payment_authorisation')),
  code_hash     text not null,                              -- sha256(code + pepper); plaintext never stored
  code_length   int  not null default 6,
  channel       text not null default 'sms' check (channel in ('sms','voice')),
  status        text not null default 'pending'
                check (status in ('pending','verified','expired','failed','blocked')),
  attempts      int  not null default 0,
  max_attempts  int  not null default 5,
  expires_at    timestamptz not null,                       -- 5 minutes
  consumed_at   timestamptz,
  verified_at   timestamptz,
  ip            inet,
  user_agent    text,
  message_id    uuid,                                       -- FK added below (messages created later)
  cooldown_until timestamptz,                               -- per-phone resend throttle
  created_at    timestamptz not null default now()
);
create index phone_verifications_lookup_idx
  on phone_verifications (phone_e164, purpose, created_at desc);
create index phone_verifications_ip_idx
  on phone_verifications (ip, created_at desc);

comment on table phone_verifications is
  'OTP challenges. The code is hashed with a server-side pepper so a database leak does not hand over live OTPs. Rate limiting is enforced on THREE axes at once: per phone (cooldown_until, max 3 per 15 min), per IP (max 10 per hour), and per attempt count (5 tries then the challenge dies). OTP SMS costs money, so this table is also the defence against someone draining the Arkesel balance.';


create table login_attempts (
  id             uuid primary key default gen_random_uuid(),
  subject_type   text not null check (subject_type in ('customer','admin','reseller','anonymous')),
  identifier     text not null,                             -- phone or email as typed
  kind           text not null check (kind in ('password','otp','totp','voucher','recovery_code','session')),
  outcome        text not null check (outcome in ('success','failure','blocked','locked_out')),
  failure_reason text,
  ip             inet,
  user_agent     text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index login_attempts_brin       on login_attempts using brin (created_at);
create index login_attempts_identifier on login_attempts (identifier, created_at desc);
create index login_attempts_ip         on login_attempts (ip, created_at desc);

comment on table login_attempts is
  'Security telemetry for brute-force detection and for answering "was it you?" in a dispute. identifier is PII; a retention job purges rows older than 90 days (see jobs kind=retention.purge_login_attempts). Successful logins are kept too — the pattern is what matters, not just failures.';


create table security_events (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null
               check (kind in ('brute_force_login','otp_abuse','voucher_guessing','webhook_signature_invalid',
                               'webhook_duplicate','rate_limit_exceeded','csrf_failure','session_hijack_suspect',
                               'privilege_escalation_attempt','excessive_device_count','fup_breach',
                               'admin_login_new_country','settings_secret_accessed','payment_amount_mismatch',
                               'replay_attack','suspicious_ip')),
  severity     text not null default 'info'
               check (severity in ('info','notice','warning','critical')),
  subject_type text,
  subject_id   uuid,
  identifier   text,
  ip           inet,
  user_agent   text,
  action_taken text,                                        -- 'rate_limited' / 'account_locked' / 'ignored'
  payload      jsonb not null default '{}'::jsonb,
  request_id   text,
  created_at   timestamptz not null default now()
);
create index security_events_brin  on security_events using brin (created_at);
create index security_events_kind  on security_events (kind, created_at desc);
create index security_events_sev   on security_events (severity, created_at desc) where severity in ('warning','critical');

comment on table security_events is
  'Discrete security incidents, distinct from login_attempts (which is a raw log) and audit_log (which is a change log). payment_amount_mismatch is the important one: it fires when a Paystack charge.success webhook reports an amount that differs from orders.total_pesewas, which is the classic attempt to pay GH¢1 for a GH¢100 plan by tampering with the client.';


-- ============================================================================
--  4. CATALOGUE — rate profiles, plans, addons, network rules, NAS registry
-- ============================================================================

create table rate_profiles (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null unique,         -- 'plan-month-basic'
  label                       text not null,                -- "10 / 5 Mbps" for the UI
  download_kbps               int  not null check (download_kbps between 8 and 10000000),
  upload_kbps                 int  not null check (upload_kbps between 8 and 10000000),
  burst_download_kbps         int  check (burst_download_kbps is null or burst_download_kbps >= download_kbps),
  burst_upload_kbps           int  check (burst_upload_kbps is null or burst_upload_kbps >= upload_kbps),
  -- NOTE: MikroTik burst-threshold is an AVERAGE RATE in bits/s, NOT a byte
  -- counter. Renaming this to _bytes is the single most common way to ship a
  -- burst config that never fires.
  burst_download_threshold_kbps int  check (burst_download_threshold_kbps is null or burst_download_threshold_kbps >= 0),
  burst_upload_threshold_kbps   int  check (burst_upload_threshold_kbps is null or burst_upload_threshold_kbps >= 0),
  burst_download_seconds      int  check (burst_download_seconds is null or burst_download_seconds between 1 and 300),
  burst_upload_seconds        int  check (burst_upload_seconds is null or burst_upload_seconds between 1 and 300),
  min_download_kbps           int,                          -- guaranteed floor (MikroTik rx-rate-min)
  min_upload_kbps             int,
  queue_priority              int  check (queue_priority is null or queue_priority between 1 and 8),
  total_queue_name            text,                         -- shared parent queue for aggregate shaping
  is_active                   boolean not null default true,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create trigger rate_profiles_touch before update on rate_profiles for each row execute function app_touch_updated_at();

comment on table rate_profiles is
  'Reusable bandwidth ceilings, rendered by the backend into the Mikrotik-Rate-Limit RADIUS reply attribute.

  *** rx/tx ARE FROM THE ROUTER''S POINT OF VIEW — READ THIS TWICE ***
  MikroTik documents Mikrotik-Rate-Limit as:
    rx-rate[/tx-rate] [rx-burst-rate[/tx-burst-rate] [rx-burst-threshold[/tx-burst-threshold]
                     [rx-burst-time[/tx-burst-time] [priority] [rx-rate-min[/tx-rate-min]]]]
  where "rx is client UPLOAD and tx is client DOWNLOAD". So a plan sold as
  "10 down / 5 up" must be rendered as  upload/download  =>  "5M/10M".
  Getting this backwards is the most common MikroTik billing bug in existence and
  it presents as "customers are slow" with no error anywhere.

  Worked example, download_kbps=10000, upload_kbps=5000, burst 20000/10000 with
  thresholds 10000/5000 for 12s, priority 8:
    Mikrotik-Rate-Limit = "5M/10M 10M/20M 5M/10M 12s/12s 8"
  Order in the string is: rate, burst-rate, burst-threshold, burst-time, priority.
  burst-threshold is an average RATE in bits/s (not a byte allowance): burst is
  permitted only while the average over burst-time stays below it. If thresholds
  are omitted MikroTik uses rx-rate/tx-rate; if burst-time is omitted it uses 1s.
  priority 1 = highest, 8 = lowest. rate-min may not exceed rate.

  Burst is what makes a GH¢5 daily plan feel fast on a phone while still capping
  the aggregate: the customer gets 20 Mbps for the first seconds of activity,
  then settles to 10. Normalising this into its own table means several plans can
  share a profile and a speed change is one UPDATE, not N.';


create table addons (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,                  -- 'topup-5gb'
  name               text not null,
  description        text,
  kind               text not null check (kind in ('data_topup','time_extension','speed_boost','device_slot')),
  price_pesewas      bigint not null check (price_pesewas >= 0),
  currency           char(3) not null default 'GHS',
  data_bytes         bigint check (data_bytes is null or data_bytes > 0),
  duration_seconds   bigint check (duration_seconds is null or duration_seconds > 0),
  extra_devices      int check (extra_devices is null or extra_devices between 1 and 10),
  rate_profile_id    uuid references rate_profiles(id) on delete restrict,   -- for speed_boost
  applies_to_plan_id uuid,                                  -- FK added below
  stackable          boolean not null default true,
  is_active          boolean not null default true,
  is_public          boolean not null default true,
  sort_order         int not null default 100,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger addons_touch before update on addons for each row execute function app_touch_updated_at();

comment on table addons is
  'PHASE 3 — bolt-ons bought against a live subscription: extra GBs, extra days, extra device slots, a temporary speed boost. Modelled now because orders.kind already needs the value and the "account page -> buy more" flow is the single highest-value upsell in this business.';


create table plans (
  id                        uuid primary key default gen_random_uuid(),
  site_id                   uuid references sites(id) on delete restrict,     -- NULL = all sites
  code                      text not null unique,             -- 'month-basic' (stable, used in URLs & SMS)
  name                      text not null,                    -- "Monthly Basic"
  tagline                   text,                             -- one line for the plan card
  description               text,
  badge                     text,                             -- "Most popular"
  kind                      text not null check (kind in ('time','data','time_and_data')),
  price_pesewas             bigint not null check (price_pesewas >= 0),
  renewal_price_pesewas     bigint check (renewal_price_pesewas is null or renewal_price_pesewas >= 0),
  currency                  char(3) not null default 'GHS',
  tax_percent               numeric(5,2) not null default 0 check (tax_percent between 0 and 100),
  duration_seconds          bigint check (duration_seconds is null or duration_seconds > 0),          -- NULL = no time limit
  data_cap_bytes            bigint check (data_cap_bytes is null or data_cap_bytes > 0),              -- NULL = no data limit
  rate_profile_id           uuid not null references rate_profiles(id) on delete restrict,
  -- Fair usage: soft throttle applied AFTER the included allowance is used.
  fup_enabled               boolean not null default false,
  fup_threshold_bytes       bigint check (fup_threshold_bytes is null or fup_threshold_bytes > 0),
  fup_rate_profile_id       uuid references rate_profiles(id) on delete restrict,
  fup_action                text not null default 'throttle'
                            check (fup_action in ('throttle','disconnect','notify_only')),
  -- Device control
  max_simultaneous_devices  int not null default 1 check (max_simultaneous_devices between 1 and 20),
  max_registered_devices    int not null default 2 check (max_registered_devices between 1 and 20),
  mac_binding_required      boolean not null default false,
  -- Session control
  session_timeout_seconds   int,                              -- forces re-auth (MikroTik/Session-Timeout)
  idle_timeout_seconds      int,                              -- logs out inactive clients, frees a device slot
  grace_seconds             int not null default 0 check (grace_seconds >= 0),   -- stays online past expiry this long
  allow_stacking            boolean not null default true,    -- renewing early extends rather than restarts
  allow_early_renewal_days  int not null default 30 check (allow_early_renewal_days >= 0),
  -- Presentation & lifecycle
  is_active                 boolean not null default true,
  is_public                 boolean not null default true,    -- shown on the portal plan list
  is_voucher_eligible       boolean not null default true,    -- can be sold as a printed voucher
  sort_order                int not null default 100,
  valid_from                timestamptz,
  valid_to                  timestamptz,
  current_revision          int not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,
  constraint plans_duration_or_cap_ck check (duration_seconds is not null or data_cap_bytes is not null),
  constraint plans_price_ck check (price_pesewas > 0 or code in ('free-trial','comp','staff')),
  constraint plans_fup_ck check (not fup_enabled or (fup_threshold_bytes is not null and fup_rate_profile_id is not null))
);
create trigger plans_touch before update on plans for each row execute function app_touch_updated_at();

create index plans_active_idx  on plans (sort_order, price_pesewas) where is_active and deleted_at is null;
create index plans_site_idx    on plans (site_id) where deleted_at is null;

comment on table plans is
  'The sellable catalogue — every field an admin needs to change price, speed, cap, device limit or duration WITHOUT a deploy. kind=time (daily/weekly, expiry is the clock), kind=data (a GB bucket, no clock), kind=time_and_data (monthly: expires at 30 days OR when the cap is hit, whichever comes first). plans_duration_or_cap_ck enforces that a plan cannot be unlimited in both dimensions for a price — that would be an unbounded giveaway. Soft-deleted so historical subscriptions keep a resolvable FK.';

alter table addons
  add constraint addons_applies_to_plan_fk
  foreign key (applies_to_plan_id) references plans(id) on delete cascade;


create table plan_revisions (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references plans(id) on delete cascade,
  revision          int  not null,
  snapshot          jsonb not null,                           -- the FULL plan row after the change
  changes           jsonb not null default '{}'::jsonb,       -- { field: { old, new } }
  change_summary    text,
  reason            text,
  effective_from    timestamptz not null default now(),
  changed_by_admin_id uuid references admin_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint plan_revisions_unique unique (plan_id, revision)
);

comment on table plan_revisions is
  'Immutable price/terms history, written by a trigger-free app-layer hook on every plan UPDATE. This is the answer to "I paid GH¢70 last month, why is it GH¢90 now?" and to "did the speed drop or did the customer imagine it?" — both are routine disputes in a reseller business. plans.current_revision points at the head.';


create table network_rules (
  id                 uuid primary key default gen_random_uuid(),
  site_id            uuid references sites(id) on delete cascade,             -- NULL = all sites
  scope              text not null default 'global'
                     check (scope in ('global','plan','user')),
  plan_id            uuid references plans(id) on delete cascade,
  user_id            uuid references users(id) on delete cascade,
  action             text not null check (action in ('block','allow')),
  match_type         text not null
                     check (match_type in ('domain','domain_suffix','ip','cidr','url_prefix','regex')),
  pattern            text not null,
  enforcement        text not null default 'dns'
                     check (enforcement in ('dns','address_list','layer7','raw_mangle','portal_only')),
  priority           int not null default 100,
  category           text check (category is null or category in ('abuse','malware','adult','gambling',
                                                                  'bandwidth_hog','legal','custom','walled_garden')),
  is_active          boolean not null default true,
  deployed_revision  int,                                    -- last revision pushed to the router
  deployed_at        timestamptz,
  deploy_error       text,
  hit_count          bigint not null default 0,              -- fed back from router counters where available
  created_by_admin_id uuid references admin_users(id) on delete set null,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint network_rules_scope_ck check (
    (scope = 'global' and plan_id is null and user_id is null) or
    (scope = 'plan'   and plan_id is not null and user_id is null) or
    (scope = 'user'   and user_id is not null)
  )
);
create trigger network_rules_touch before update on network_rules for each row execute function app_touch_updated_at();
create index network_rules_active_idx on network_rules (priority, action) where is_active;

-- Natural key, so the seed and the config renderer are idempotent.
-- Without this, `ON CONFLICT DO NOTHING` never conflicts (the only unique
-- constraint would be the generated id) and re-running the seed silently
-- duplicates every rule — which then renders a doubled RouterOS script.
-- The coalesce() terms are required because NULLs are distinct in a unique
-- index, so a global rule would otherwise never collide with itself.
create unique index network_rules_natural_key on network_rules (
  scope,
  action,
  match_type,
  pattern,
  coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(plan_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

comment on table network_rules is
  'Block/allow list, edited in the dashboard and RENDERED to a RouterOS script (Phase 3 deliverable) rather than pushed live. enforcement says how it lands: dns = a DNS forwarder rule on the edge box (cheap, catches most, trivially bypassed by DoH — so also ship a DoH block); address_list = /ip firewall address-list + filter drop; layer7 = for URL prefixes that survive TLS only via SNI; walled_garden = the inverse, for the payment/SMS/portal domains that must stay reachable for an UNAUTHENTICATED client. category=bandwidth_hog is the honest one for a Starlink backhaul: blocking video CDNs on the cheap plans protects everyone else.';


create table nas_devices (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid not null references sites(id) on delete restrict,
  name              text not null unique,                   -- 'nkawie-hap-ax3'
  shortname         text not null,
  kind              text not null default 'mikrotik'
                    check (kind in ('mikrotik','other')),
  ip_address        inet not null,                          -- LAN address of the router
  mac_address       text,
  model             text,                                   -- 'hAP ax3'
  routeros_version  text,                                   -- '7.16.2'
  serial_number     text,
  shared_secret_ref text not null,                          -- e.g. 'edge:env:RADIUS_SECRET_NKAWIE01' — NEVER the secret
  coa_enabled       boolean not null default true,
  coa_port          int not null default 3799,
  walled_garden_revision int not null default 0,
  status            text not null default 'active'
                    check (status in ('active','inactive','retired')),
  last_seen_at      timestamptz,
  last_acct_at      timestamptz,
  firmware_notes    text,
  created_by_admin_id uuid references admin_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger nas_devices_touch before update on nas_devices for each row execute function app_touch_updated_at();

comment on table nas_devices is
  'Cloud-side registry of RADIUS clients (the MikroTik routers). shared_secret_ref is a POINTER, not the secret: the real shared secret exists only in the edge node environment and in the router config, so a cloud database breach cannot let an attacker forge accounting or send CoA disconnects. The edge sync agent reads this table to generate its local /etc/raddb/clients.conf. last_acct_at is the heartbeat — if it goes stale for 10 minutes the dashboard shows the site as degraded.';


-- ============================================================================
--  5. ORDERS & PAYMENTS  (money in, money out)
-- ============================================================================

create table orders (
  id                   uuid primary key default gen_random_uuid(),
  ref                  text not null unique,                -- 'WV-26-000123' human-readable, on the receipt & in SMS
  idempotency_key      text not null unique,                -- client-generated UUID; makes "pay" retries safe
  user_id              uuid references users(id) on delete restrict,
  site_id              uuid references sites(id) on delete set null,
  kind                 text not null
                       check (kind in ('subscription_new','subscription_renew','voucher_purchase','addon','wallet_topup')),
  plan_id              uuid references plans(id) on delete restrict,
  plan_revision        int,                                 -- revision purchased; pins the terms
  addon_id             uuid references addons(id) on delete restrict,
  subscription_id      uuid,                                -- FK added below (circular with subscriptions)
  voucher_batch_id     uuid,                                -- FK added below
  reseller_id          uuid references resellers(id) on delete set null,
  quantity             int not null default 1 check (quantity between 1 and 10000),
  unit_price_pesewas   bigint not null check (unit_price_pesewas >= 0),
  discount_pesewas     bigint not null default 0 check (discount_pesewas >= 0),
  tax_pesewas          bigint not null default 0 check (tax_pesewas >= 0),
  total_pesewas        bigint not null check (total_pesewas >= 0),
  currency             char(3) not null default 'GHS',
  status               text not null default 'pending_payment'
                       check (status in ('draft','pending_payment','processing','paid','failed',
                                         'cancelled','expired','refunded','partially_refunded','void')),
  -- Payer details. Kept on the order (not just the attempt) because a guest can
  -- pay with a different MoMo number than the account phone.
  payer_phone_e164     text not null,
  payer_phone_local    text not null,
  payer_network        text,                                -- operator code actually used: mtn / telecel / airteltigo
  payer_name           text,                                -- from Paystack authorization.account_name, when present
  -- Lifecycle
  expires_at           timestamptz not null,                -- abandon after 15 min; frees the idempotency slot semantics
  paid_at              timestamptz,
  fulfilled_at         timestamptz,                         -- subscription activated / vouchers generated
  fulfilment_error     text,
  cancelled_at         timestamptz,
  cancel_reason        text,
  refunded_pesewas     bigint not null default 0 check (refunded_pesewas >= 0),
  -- Attribution / abuse context
  channel              text not null default 'portal'
                       check (channel in ('portal','admin','reseller','api','ussd','sms')),
  ip_address           inet,
  user_agent           text,
  created_by_admin_id  uuid references admin_users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  version              int not null default 0,              -- optimistic lock for webhook vs. verify race
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint orders_payer_phone_ck check (payer_phone_e164 ~ '^\+233[0-9]{9}$'),
  constraint orders_total_ck check (
    total_pesewas = (unit_price_pesewas * quantity) - discount_pesewas + tax_pesewas
  ),
  constraint orders_refund_ck check (refunded_pesewas <= total_pesewas)
);
create trigger orders_touch before update on orders for each row execute function app_touch_updated_at();

create index orders_user_idx        on orders (user_id, created_at desc);
create index orders_status_idx      on orders (status, created_at desc);
create index orders_created_brin    on orders using brin (created_at);
create index orders_pending_expiry  on orders (expires_at) where status in ('pending_payment','processing');
create index orders_site_day_idx    on orders (site_id, created_at desc);

comment on table orders is
  'The customer-facing intent to buy: one row per checkout, regardless of how many payment attempts it takes. orders.total_pesewas is computed from the plan AT ORDER TIME and pinned by the orders_total_ck constraint — the client sends only plan code + quantity + idempotency key, never an amount. idempotency_key is unique so a double-tapped "Pay GH¢70" button on a laggy 3G connection cannot create two charges. expires_at (15 min) matters because Paystack gives the customer a 180-second MoMo approval window and we do not want stale orders sitting in pending_payment forever.';


create table subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references users(id) on delete restrict,
  plan_id                   uuid not null references plans(id) on delete restrict,
  site_id                   uuid references sites(id) on delete set null,
  order_id                  uuid references orders(id) on delete restrict,     -- NULL only for manual comp
  voucher_id                uuid,                                              -- FK added below
  reseller_id               uuid references resellers(id) on delete set null,
  plan_revision             int not null,
  -- Terms SNAPSHOT at purchase time. Editing a plan must never retroactively
  -- change what a customer already paid for.
  snapshot_name             text not null,
  snapshot_kind             text not null,
  snapshot_price_pesewas    bigint not null,
  snapshot_duration_seconds bigint,
  snapshot_data_cap_bytes   bigint,
  snapshot_rate_profile_id  uuid not null references rate_profiles(id) on delete restrict,
  snapshot_fup_threshold_bytes bigint,
  snapshot_fup_rate_profile_id uuid references rate_profiles(id) on delete restrict,
  snapshot_max_simultaneous_devices int not null,
  snapshot_max_registered_devices   int not null,
  snapshot_mac_binding_required     boolean not null,
  -- State
  status                    text not null default 'scheduled'
                            check (status in ('scheduled','active','expired','suspended',
                                              'cancelled','refunded','fup_throttled')),
  starts_at                 timestamptz not null,
  expires_at                timestamptz,                                       -- NULL = no time limit
  grace_ends_at             timestamptz,
  data_used_bytes           bigint not null default 0 check (data_used_bytes >= 0),
  seconds_used              bigint not null default 0 check (seconds_used >= 0),
  last_usage_at             timestamptz,
  fup_applied_at            timestamptz,
  fup_cleared_at            timestamptz,
  auto_renew                boolean not null default false,
  renewal_attempts          int not null default 0,
  renewed_from_id           uuid references subscriptions(id) on delete set null,
  stacked_from_id           uuid references subscriptions(id) on delete set null,
  -- Manual intervention
  suspended_at              timestamptz,
  suspended_by_admin_id     uuid references admin_users(id) on delete set null,
  suspension_reason         text,
  extended_by_admin_id      uuid references admin_users(id) on delete set null,
  extension_seconds         bigint not null default 0,
  extension_reason          text,
  cancelled_at              timestamptz,
  cancellation_reason       text,
  -- Reminder bookkeeping is done via messages.dedupe_key, not columns here.
  activated_at              timestamptz,
  expired_at                timestamptz,
  version                   int not null default 0,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create trigger subscriptions_touch before update on subscriptions for each row execute function app_touch_updated_at();

create unique index subscriptions_one_active_per_user
  on subscriptions (user_id) where status = 'active';
create index subscriptions_expiry_idx on subscriptions (expires_at) where status in ('active','scheduled','fup_throttled');
create index subscriptions_user_idx   on subscriptions (user_id, created_at desc);
create index subscriptions_status_idx on subscriptions (status, starts_at desc);
create index subscriptions_voucher_idx on subscriptions (voucher_id);

comment on table subscriptions is
  'One row per purchased entitlement period — a ledger, not a mutable "current plan". Buying a second month while the first is still running creates a row with status=scheduled and starts_at = current.expires_at, which is what makes "renew early and keep your remaining days" work honestly. subscriptions_one_active_per_user (a PARTIAL unique index) guarantees at most one live entitlement per customer at the database level, so a webhook delivered twice cannot give someone two concurrent plans. The snapshot_* columns freeze price, cap, speed and device limits at the moment of purchase: an admin repricing a plan next month must not silently downgrade a customer who already paid.';


alter table orders
  add constraint orders_subscription_fk
  foreign key (subscription_id) references subscriptions(id) on delete set null;


create table reseller_payouts (
  id                    uuid primary key default gen_random_uuid(),
  reseller_id           uuid not null references resellers(id) on delete restrict,
  amount_pesewas        bigint not null check (amount_pesewas > 0),
  currency              char(3) not null default 'GHS',
  method                text not null default 'momo' check (method in ('momo','bank','cash')),
  status                text not null default 'requested'
                        check (status in ('requested','approved','processing','paid','failed','cancelled')),
  period_from           date,
  period_to             date,
  provider              text,                               -- 'paystack_transfer' when paid by MoMo transfer
  provider_transfer_id  uuid,
  provider_reference    text,
  transfer_recipient_code text,
  requested_by_admin_id uuid references admin_users(id) on delete set null,
  approved_by_admin_id  uuid references admin_users(id) on delete set null,
  approved_at           timestamptz,
  paid_at               timestamptz,
  failure_reason        text,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger reseller_payouts_touch before update on reseller_payouts for each row execute function app_touch_updated_at();
create index reseller_payouts_reseller_idx on reseller_payouts (reseller_id, created_at desc);


create table reseller_ledger (
  id                    uuid primary key default gen_random_uuid(),
  reseller_id           uuid not null references resellers(id) on delete restrict,
  entry_type            text not null
                        check (entry_type in ('commission_earned','voucher_book_purchase','payout','payout_failed_reversal',
                                              'manual_adjustment','reversal')),
  amount_pesewas        bigint not null,                    -- signed
  balance_after_pesewas bigint not null,
  order_id              uuid references orders(id) on delete set null,
  subscription_id       uuid references subscriptions(id) on delete set null,
  voucher_id            uuid,                               -- FK added below
  voucher_batch_id      uuid,                               -- FK added below
  payout_id             uuid references reseller_payouts(id) on delete set null,
  reference             text,
  description           text not null,
  created_by_admin_id   uuid references admin_users(id) on delete set null,
  created_at            timestamptz not null default now()
);
create index reseller_ledger_reseller_idx on reseller_ledger (reseller_id, created_at desc);
create index reseller_ledger_type_idx     on reseller_ledger (entry_type, created_at desc);

comment on table reseller_ledger is
  'Append-only double-entry-ish ledger for reseller wallets. balance_after_pesewas is written by the app inside the same transaction as the balance change, so any disagreement between the running column and resellers.wallet_balance_pesewas is immediately visible — that check is a nightly job.';


create table payment_attempts (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  uuid not null references orders(id) on delete cascade,
  provider                  text not null default 'paystack'
                            check (provider in ('paystack','hubtel','moolre','cash','bank_transfer')),
  reference                 text not null unique,           -- OUR reference sent to the provider
  provider_transaction_id   bigint,                         -- Paystack data.id
  provider_status           text,                           -- raw provider status string
  channel                   text check (channel is null or channel in ('mobile_money','card','ussd','bank','transfer','cash')),
  momo_network              text check (momo_network is null or momo_network in ('mtn','telecel','airteltigo')),
  momo_provider_code        text,                           -- the code actually sent: 'mtn' | 'vod' | 'atl'
  payer_phone_e164          text not null,
  payer_phone_local         text not null,
  amount_pesewas            bigint not null check (amount_pesewas > 0),
  fees_pesewas              bigint,                         -- provider fees as reported on success
  currency                  char(3) not null default 'GHS',
  status                    text not null default 'created'
                            check (status in ('created','pending','awaiting_customer_action','otp_required',
                                              'success','failed','abandoned','timeout','processing')),
  next_action               text check (next_action is null or next_action in
                            ('submit_otp','submit_phone','submit_birthday','open_url','dial_ussd','wait_for_webhook','poll_verify')),
  display_text              text,                           -- Paystack display_text, shown verbatim to the customer
  authorization_url         text,
  gateway_response          text,
  failure_code              text,
  failure_reason            text,
  authorization_code        text,                           -- Paystack AUTH_* (not reusable for MoMo, but store it)
  authorization_last4       text,
  authorization_bank        text,                           -- 'MTN Mobile Money' — the CONFIRMED network
  authorization_account_name text,
  customer_action_deadline_at timestamptz,                  -- initiated_at + 180s for MoMo
  request_payload           jsonb not null default '{}'::jsonb,
  last_response_payload     jsonb not null default '{}'::jsonb,
  verify_count              int not null default 0,
  last_verified_at          timestamptz,
  initiated_at              timestamptz not null default now(),
  resolved_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint payment_attempts_reference_ck check (reference ~ '^WV-[A-Za-z0-9-]{4,60}$')
);
create trigger payment_attempts_touch before update on payment_attempts for each row execute function app_touch_updated_at();

create index payment_attempts_order_idx  on payment_attempts (order_id, created_at desc);
create index payment_attempts_open_idx   on payment_attempts (status, initiated_at desc)
  where status in ('created','pending','awaiting_customer_action','otp_required','processing');

comment on table payment_attempts is
  'One row per try at collecting money. An order can have several: the customer fails on Telecel, retries on MTN, then pays by card. `reference` is OURS (WV-<orderRef>-<n>) and is what Paystack echoes back — it is the join key for webhooks and verify calls, and it is unique so a replayed webhook cannot attach to the wrong attempt.
  The status machine mirrors what Paystack actually returns from POST /charge for Ghana MoMo:
    pay_offline (MTN, AirtelTigo) -> approve the prompt on the phone -> charge.success webhook
    send_otp    (Telecel)         -> customer dials *110#, we POST /charge/submit_otp
    pending                       -> wait >=10s, then GET /transaction/check_pending/:reference
  display_text is stored because it is the operator-specific instruction we must show verbatim ("Please dial *110#...") — inventing our own copy here is how customers get stuck.
  CRITICAL: response envelope status:true does NOT mean the charge succeeded. Only data.status does. See docs/08-security.md.';


create table payment_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null default 'paystack',
  event_type         text not null,                          -- 'charge.success', 'charge.failed', 'refund.processed', ...
  -- Paystack sends NO unique event id and retries the webhook on any non-2xx.
  -- So idempotency has to be built from the payload, not a provider id.
  dedupe_key         text not null unique,                   -- sha256(provider|event|data.id|data.status|data.reference)
  body_hash          text not null,                          -- sha256 of the exact raw request body
  resource_type      text,                                   -- 'transaction' / 'refund' / 'transfer' / 'dispute'
  resource_id        text,
  resource_reference text,                                   -- ties straight back to payment_attempts.reference
  resource_status    text,
  attempt_id         uuid references payment_attempts(id) on delete set null,
  order_id           uuid references orders(id) on delete set null,
  amount_pesewas     bigint,
  currency           char(3),
  payload            jsonb not null,                         -- the full raw body, parsed
  signature_header   text,
  signature_valid    boolean not null default false,
  received_at        timestamptz not null default now(),
  processing_status  text not null default 'received'
                     check (processing_status in ('received','processing','processed','ignored','failed')),
  processed_at       timestamptz,
  processing_attempts int not null default 0,
  last_error         text,
  ip                 inet,
  request_id         text,
  created_at         timestamptz not null default now()
);
create index payment_events_ref_idx     on payment_events (resource_reference, received_at desc);
create index payment_events_type_idx    on payment_events (event_type, received_at desc);
create index payment_events_unprocessed on payment_events (received_at) where processing_status in ('received','failed');
create index payment_events_brin        on payment_events using brin (received_at);

comment on table payment_events is
  'The webhook INBOX. Every inbound event is INSERTed here FIRST, in its own transaction, before any business logic runs — and the insert is the idempotency gate. `dedupe_key` is a unique index over a hash of (provider, event, data.id, data.status, data.reference), because Paystack does not supply an event UUID and WILL redeliver the same event whenever we answer anything other than 2xx. A duplicate therefore hits a unique violation and the handler returns 200 immediately without re-activating a subscription. body_hash catches a replayed body under a different event key. signature_valid records whether x-paystack-signature (HMAC-SHA512 of the RAW body with the secret key) verified — we still persist failed ones, because a signature failure is a security_event worth keeping evidence of.';


create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id) on delete restrict,
  attempt_id         uuid references payment_attempts(id) on delete restrict,
  subscription_id    uuid references subscriptions(id) on delete set null,
  user_id            uuid references users(id) on delete restrict,
  amount_pesewas     bigint not null check (amount_pesewas > 0),
  currency           char(3) not null default 'GHS',
  method             text not null default 'provider'
                     check (method in ('provider','wallet_credit','cash','momo_transfer')),
  reason             text not null
                     check (reason in ('duplicate_charge','payment_taken_not_activated','service_outage',
                                       'speed_below_advertised','customer_request','fraud','goodwill',
                                       'overcharge','cancelled_before_use','other')),
  reason_detail      text,
  status             text not null default 'requested'
                     check (status in ('requested','approved','processing','processed','failed','rejected','cancelled')),
  provider           text,
  provider_refund_id text,
  provider_status    text,
  wallet_entry_id    uuid references wallet_entries(id) on delete set null,
  requested_by_admin_id uuid references admin_users(id) on delete restrict,
  approved_by_admin_id  uuid references admin_users(id) on delete set null,
  approved_at        timestamptz,
  processed_at       timestamptz,
  failure_reason     text,
  entitlement_revoked boolean not null default false,       -- did we cancel/shorten the subscription?
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger refunds_touch before update on refunds for each row execute function app_touch_updated_at();
create index refunds_order_idx  on refunds (order_id);
create index refunds_open_idx   on refunds (status, created_at desc) where status not in ('processed','rejected','cancelled');

comment on table refunds is
  'Refund requests and their outcome. approval requires a DIFFERENT admin than the requester (enforced in middleware, not here) so one compromised account cannot drain the till. method=wallet_credit is the fast path: instant, free, and the customer keeps using the service — usually the right call for a GH¢5 duplicate charge. method=provider calls POST /refund and waits for the refund.processed webhook. entitlement_revoked records whether the subscription was also pulled back, which is what makes the revenue report honest.';


create table receipts (
  id                uuid primary key default gen_random_uuid(),
  receipt_number    text not null unique,                    -- 'WV-R-26-000123'
  receipt_type      text not null default 'sale'
                    check (receipt_type in ('sale','refund','credit_note','voucher_sale')),
  order_id          uuid references orders(id) on delete restrict,
  refund_id         uuid references refunds(id) on delete set null,
  parent_receipt_id uuid references receipts(id) on delete set null,
  user_id           uuid references users(id) on delete restrict,
  site_id           uuid references sites(id) on delete set null,
  issued_at         timestamptz not null default now(),
  customer_name     text,
  customer_phone_e164 text not null,
  line_items        jsonb not null,                          -- [{description, qty, unit_pesewas, total_pesewas}]
  subtotal_pesewas  bigint not null,
  tax_pesewas       bigint not null default 0,
  total_pesewas     bigint not null,
  currency          char(3) not null default 'GHS',
  payment_method    text,                                    -- 'MTN Mobile Money'
  provider          text,
  provider_reference text,
  plan_description  text,                                    -- "30 days, 100 GB, up to 10/5 Mbps"
  valid_from        timestamptz,
  valid_to          timestamptz,
  sms_sent_at       timestamptz,
  pdf_path          text,
  void_at           timestamptz,
  void_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger receipts_touch before update on receipts for each row execute function app_touch_updated_at();
create index receipts_user_idx on receipts (user_id, issued_at desc);
create index receipts_order_idx on receipts (order_id);

comment on table receipts is
  'The document a customer can point at. line_items is a JSON snapshot rather than a join because a receipt must never change after issue — if the plan is renamed next month, last month''s receipt still says what it said. Issued automatically on paid + on refund (as a credit_note with parent_receipt_id). Delivered on-screen and by SMS (the SMS carries number, amount, plan and expiry — under 160 chars so it costs one segment).';


create table settlements (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null default 'paystack',
  provider_settlement_id text not null,
  status                text not null
                        check (status in ('pending','processing','success','failed','abandoned')),
  currency              char(3) not null default 'GHS',
  gross_pesewas         bigint not null,
  fees_pesewas          bigint not null default 0,
  net_pesewas           bigint not null,
  amount_pesewas        bigint,
  settled_at            timestamptz,
  category              text,
  transfer_recipient    text,
  reconciled_at         timestamptz,
  discrepancy_pesewas   bigint,
  discrepancy_note      text,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint settlements_provider_unique unique (provider, provider_settlement_id)
);
create trigger settlements_touch before update on settlements for each row execute function app_touch_updated_at();

comment on table settlements is
  'Paystack pays out to your bank/MoMo on a schedule; this is the reconciliation record. reconciled_at + discrepancy_pesewas is the answer to "Paystack says they settled GH¢1,240 but I counted GH¢1,300 in orders" — which WILL happen, because fees and refunds net out. A nightly job pulls GET /settlement and diffs against payment_attempts.';


create table settlement_items (
  id             uuid primary key default gen_random_uuid(),
  settlement_id  uuid not null references settlements(id) on delete cascade,
  attempt_id     uuid references payment_attempts(id) on delete set null,
  order_id       uuid references orders(id) on delete set null,
  category       text,
  amount_pesewas bigint not null,
  fee_pesewas    bigint not null default 0,
  processed_at   timestamptz,
  created_at     timestamptz not null default now(),
  constraint settlement_items_unique unique (settlement_id, attempt_id, category)
);
create index settlement_items_attempt_idx on settlement_items (attempt_id);


create table revenue_daily (
  site_id                uuid not null references sites(id) on delete cascade,
  day                    date not null,                     -- in Africa/Accra
  orders_count           int not null default 0,
  paid_orders_count      int not null default 0,
  failed_orders_count    int not null default 0,
  gross_pesewas          bigint not null default 0,
  fees_pesewas           bigint not null default 0,
  net_pesewas            bigint not null default 0,
  refunds_pesewas        bigint not null default 0,
  voucher_sales_pesewas  bigint not null default 0,
  voucher_units          int not null default 0,
  new_subscriptions      int not null default 0,
  renewals               int not null default 0,
  wallet_credit_pesewas  bigint not null default 0,
  by_network             jsonb not null default '{}'::jsonb,-- {"mtn": 42000, "telecel": 15000, "airteltigo": 5000}
  by_plan                jsonb not null default '{}'::jsonb,-- {"month-basic": 6, "week-1": 12}
  avg_order_pesewas      bigint not null default 0,
  computed_at            timestamptz not null default now(),
  primary key (site_id, day)
);

comment on table revenue_daily is
  'Pre-aggregated daily revenue, one row per site per day, recomputed idempotently by a nightly job (and on demand from the dashboard). Without it the dashboard runs SUM() over orders on every page load, which is fine at 100 users and miserable at 5,000 — and this is the table that makes the "revenue today / this week / this month" tiles instant. by_network is the one that matters operationally: if MTN revenue collapses to zero on a Tuesday, the MoMo channel is down, not your business.';


-- ============================================================================
--  6. USAGE & ACCOUNTING (uplink from the edge node)
-- ============================================================================

create table usage_records (
  id                  bigserial primary key,
  origin_id           text not null,                        -- edge-assigned UUID; idempotent uplink key
  edge_node_id        uuid references api_tokens(id) on delete set null,
  site_id             uuid references sites(id) on delete set null,
  nas_device_id       uuid references nas_devices(id) on delete set null,
  user_id             uuid references users(id) on delete set null,
  subscription_id     uuid references subscriptions(id) on delete set null,
  record_type         text not null check (record_type in ('start','interim-update','stop')),
  acctsessionid       text not null,
  acctuniqueid        text not null,
  username            text not null,
  nas_ip_address      inet,
  nas_port_id         text,
  nas_port_type       text,
  calling_station_id  text,                                 -- client MAC (normalised)
  called_station_id   text,                                 -- AP MAC / SSID
  framed_ip_address   inet,
  acct_start_time     timestamptz not null,
  acct_update_time    timestamptz,
  acct_stop_time      timestamptz,
  acct_session_time   bigint not null default 0,            -- seconds
  acct_input_octets   bigint not null default 0,            -- uploaded by the client
  acct_output_octets  bigint not null default 0,            -- downloaded to the client
  acct_input_packets  bigint not null default 0,
  acct_output_packets bigint not null default 0,
  acct_terminate_cause text,
  acct_authentic      text,
  connect_info_start  text,
  connect_info_stop   text,
  source              text not null default 'radius_edge'
                      check (source in ('radius_edge','router_api','manual','reconciled')),
  ingested_at         timestamptz not null default now(),
  constraint usage_records_origin_unique unique (origin_id)
);
create index usage_records_user_time_idx   on usage_records (user_id, acct_start_time desc);
create index usage_records_sub_time_idx    on usage_records (subscription_id, acct_start_time desc);
create index usage_records_session_idx     on usage_records (acctsessionid, nas_ip_address);
create index usage_records_start_brin      on usage_records using brin (acct_start_time);
create index usage_records_unrolled_idx    on usage_records (acct_start_time) where record_type = 'stop';

comment on table usage_records is
  'The cloud copy of RADIUS accounting, pushed by the edge node in batches. origin_id is a UNIQUE constraint, which is what makes the uplink idempotent: the edge keeps a local outbox and retries until the cloud acks, so a flaky Starlink link can never double-count a customer''s data. user_id / subscription_id are resolved by username at ingest time so the dashboard never joins on a text username.
  NOTE on octets: FreeRADIUS/MikroTik report 32-bit counters that WRAP at 4 GiB. The edge agent widens them using Acct-Input-Gigawords / Acct-Output-Gigawords and de-wraps across interim updates; if it cannot, it marks source=reconciled. Getting this wrong silently under-bills heavy users — see docs/04-freeradius.md.
  Retention: raw rows kept 13 months, then folded into usage_daily and purged. Scale step at >20M rows: convert to monthly RANGE partitioning on acct_start_time (documented in docs/02-database-schema.md); BRIN indexing makes the unpartitioned version fine well past 10M.';


create table usage_daily (
  id              bigserial primary key,
  user_id         uuid not null references users(id) on delete cascade,
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  site_id         uuid references sites(id) on delete set null,
  day             date not null,                            -- in Africa/Accra
  bytes_in        bigint not null default 0,
  bytes_out       bigint not null default 0,
  bytes_total     bigint generated always as (bytes_in + bytes_out) stored,
  session_seconds bigint not null default 0,
  session_count   int not null default 0,
  peak_download_kbps int,
  computed_at     timestamptz not null default now(),
  constraint usage_daily_unique unique (user_id, subscription_id, day)
);
create index usage_daily_day_idx  on usage_daily (day desc);
create index usage_daily_site_day on usage_daily (site_id, day desc);

comment on table usage_daily is
  'Per-customer per-day rollup of usage_records. This is what powers the "usage history" list on the account page and the "bandwidth used" + "top users" tiles on the dashboard, and it is why those queries stay fast after a year of data. subscription_id is NOT NULL here on purpose: usage that cannot be attributed to an entitlement stays in usage_records and is surfaced as an anomaly, not silently absorbed.';


-- ============================================================================
--  7. SUBSCRIPTION LIFECYCLE EVENTS
-- ============================================================================

create table subscription_events (
  id              bigserial primary key,
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  event_type      text not null
                  check (event_type in ('created','scheduled','activated','renewed','extended','stacked',
                                        'data_cap_warning','data_cap_reached','throttled','unthrottled',
                                        'suspended','resumed','expired','grace_started','disconnected',
                                        'cancelled','refunded','device_blocked','device_added','device_removed',
                                        'manual_override','coa_sent','coa_failed')),
  reason          text,
  actor_type      text not null default 'system'
                  check (actor_type in ('system','admin','customer','webhook','edge_node')),
  actor_id        text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index subscription_events_sub_idx  on subscription_events (subscription_id, created_at desc);
create index subscription_events_user_idx on subscription_events (user_id, created_at desc);
create index subscription_events_brin     on subscription_events using brin (created_at);

comment on table subscription_events is
  'The human-readable timeline of an entitlement, and the single most useful table in a support conversation. "Why was I cut off at 9pm?" is answered by reading four rows. coa_sent / coa_failed are logged because the Change-of-Authorisation packet to the MikroTik is how live throttling and instant disconnect actually happen, and it is also the thing most likely to be silently broken (wrong /radius incoming secret, firewall, a router reboot) — so it must be observable.';


-- ============================================================================
--  8. VOUCHERS
-- ============================================================================

create table voucher_batches (
  id                  uuid primary key default gen_random_uuid(),
  code_prefix         text not null,                         -- 'NK1' -> NK1-XXXX-XXXX
  label               text not null,                         -- "March market-day book"
  plan_id             uuid not null references plans(id) on delete restrict,
  kind                text not null default 'plan' check (kind in ('plan','credit')),
  quantity            int not null check (quantity between 1 and 100000),
  generated_count     int not null default 0,
  face_value_pesewas  bigint not null check (face_value_pesewas >= 0),          -- retail price
  unit_cost_pesewas   bigint not null check (unit_cost_pesewas >= 0),           -- what a reseller pays us
  credit_pesewas      bigint check (credit_pesewas is null or credit_pesewas > 0),
  reseller_id         uuid references resellers(id) on delete set null,
  site_id             uuid references sites(id) on delete set null,
  expires_at          timestamptz,                           -- redemption deadline for the whole book
  status              text not null default 'draft'
                      check (status in ('draft','generated','printing','active','partially_sold','sold_out','void')),
  order_id            uuid references orders(id) on delete set null,            -- the reseller's purchase order
  csv_exported_at     timestamptz,
  pdf_exported_at     timestamptz,
  void_at             timestamptz,
  void_reason         text,
  notes               text,
  created_by_admin_id uuid references admin_users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint voucher_batches_prefix_ck check (code_prefix ~ '^[A-Z0-9]{2,6}$')
);
create trigger voucher_batches_touch before update on voucher_batches for each row execute function app_touch_updated_at();
create index voucher_batches_status_idx on voucher_batches (status, created_at desc);
create index voucher_batches_reseller_idx on voucher_batches (reseller_id) where reseller_id is not null;

alter table orders
  add constraint orders_voucher_batch_fk
  foreign key (voucher_batch_id) references voucher_batches(id) on delete set null;
alter table reseller_ledger
  add constraint reseller_ledger_batch_fk
  foreign key (voucher_batch_id) references voucher_batches(id) on delete set null;

comment on table voucher_batches is
  'A print run. Batching is what makes voucher economics work: you generate 200 codes once, export one CSV/PDF, hand the book to a shopkeeper, and reconcile sold vs. unsold per book rather than per code. face_value_pesewas (retail) vs unit_cost_pesewas (wholesale) is the reseller margin. Voiding a batch instantly kills every unused code in it — the response to a lost or stolen book.';


create table vouchers (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references voucher_batches(id) on delete cascade,
  code                text not null unique,                  -- 'NK1-7QK4-M2XD'
  plan_id             uuid not null references plans(id) on delete restrict,
  kind                text not null default 'plan' check (kind in ('plan','credit')),
  face_value_pesewas  bigint not null check (face_value_pesewas >= 0),
  credit_pesewas      bigint check (credit_pesewas is null or credit_pesewas > 0),
  status              text not null default 'unused'
                      check (status in ('unused','reserved','redeemed','void','expired')),
  expires_at          timestamptz,                           -- redemption deadline
  -- Reseller assignment (a book is allocated to a reseller, then sold code by code)
  reseller_id         uuid references resellers(id) on delete set null,
  assigned_at         timestamptz,
  sold_at             timestamptz,
  sold_for_pesewas    bigint,
  -- Redemption
  redeemed_by_user_id uuid references users(id) on delete set null,
  redeemed_at         timestamptz,
  redemption_ip       inet,
  redemption_mac      text,
  redemption_site_id  uuid references sites(id) on delete set null,
  subscription_id     uuid,                                  -- FK added below
  redeem_attempts     int not null default 0,
  -- Exports
  printed_at          timestamptz,
  exported_at         timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  notes               text,
  version             int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint vouchers_code_ck check (code ~ '^[A-Z0-9]{2,6}(-[0-9A-Z]{4}){1,3}$')
);
create trigger vouchers_touch before update on vouchers for each row execute function app_touch_updated_at();

create index vouchers_batch_status_idx on vouchers (batch_id, status);
create index vouchers_reseller_idx     on vouchers (reseller_id, status);
create index vouchers_expiry_idx       on vouchers (expires_at) where status = 'unused';
create index vouchers_redeemed_idx     on vouchers (redeemed_by_user_id, redeemed_at desc);

comment on table vouchers is
  'Individual prepaid codes. status transitions are enforced with a conditional UPDATE (where status = ''unused'' and version = :v), not just app logic, so two people redeeming the same code at the same instant on two phones cannot both succeed. redeem_attempts is capped (5 per code, 20 per IP per hour) because voucher guessing is the number one attack on this kind of system; codes carry ~60 bits of Crockford-base32 entropy plus a check digit, and every miss is written to security_events as voucher_guessing. CSV/PDF export writes exported_at so a reprint is deliberate.';

alter table subscriptions
  add constraint subscriptions_voucher_fk
  foreign key (voucher_id) references vouchers(id) on delete set null;
alter table vouchers
  add constraint vouchers_subscription_fk
  foreign key (subscription_id) references subscriptions(id) on delete set null;
alter table reseller_ledger
  add constraint reseller_ledger_voucher_fk
  foreign key (voucher_id) references vouchers(id) on delete set null;
alter table users
  add constraint users_active_subscription_fk
  foreign key (active_subscription_id) references subscriptions(id) on delete set null;


-- ============================================================================
--  9. MESSAGING (SMS via Arkesel)
-- ============================================================================

create table message_templates (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,                        -- 'sms.otp.login'
  channel       text not null check (channel in ('sms','email','voice')),
  locale        text not null default 'en',
  title         text not null,
  body          text not null,                               -- {{first_name}} {{plan_name}} {{amount}} {{expiry}}
  variables     jsonb not null default '[]'::jsonb,          -- [{name, example, required}]
  category      text not null default 'operational'
                check (category in ('otp','receipt','reminder','operational','marketing','security')),
  max_segments  int not null default 1,
  is_active     boolean not null default true,
  notes         text,
  updated_by_admin_id uuid references admin_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger message_templates_touch before update on message_templates for each row execute function app_touch_updated_at();

comment on table message_templates is
  'Editable SMS copy. category drives the send policy: otp/receipt/reminder/security are TRANSACTIONAL and may go at any hour; marketing is subject to the Ghana promotional window (08:00-19:00, not Sundays) and to users.marketing_consent. max_segments keeps copy honest — a 161-character message costs 2 segments, so a "friendly reminder" that quietly doubles your Arkesel bill is a business problem, not a copy problem.';


create table messages (
  id                  uuid primary key default gen_random_uuid(),
  dedupe_key          text unique,                           -- e.g. 'reminder:expiry_d2:<subscription_id>'
  template_id         uuid references message_templates(id) on delete set null,
  template_key        text,
  channel             text not null check (channel in ('sms','email','voice')),
  category            text not null default 'operational'
                      check (category in ('otp','receipt','reminder','operational','marketing','security')),
  user_id             uuid references users(id) on delete set null,
  admin_user_id       uuid references admin_users(id) on delete set null,
  reseller_id         uuid references resellers(id) on delete set null,
  order_id            uuid references orders(id) on delete set null,
  subscription_id     uuid references subscriptions(id) on delete set null,
  to_address          text not null,
  sender_id           text,                                  -- Arkesel registered sender ID, max 11 chars
  subject             text,
  body                text not null,
  variables           jsonb not null default '{}'::jsonb,
  status              text not null default 'queued'
                      check (status in ('queued','sending','sent','delivered','undelivered','failed','suppressed','expired')),
  provider            text not null default 'arkesel',
  provider_message_id text,                                  -- Arkesel data[].id, matched against the delivery callback
  provider_status     text,
  segments            int,
  cost_pesewas        bigint,
  error_code          text,
  error_message       text,
  request_payload     jsonb not null default '{}'::jsonb,
  response_payload    jsonb not null default '{}'::jsonb,
  scheduled_for       timestamptz,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  delivery_report_at  timestamptz,
  retry_count         int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint messages_sender_id_ck check (sender_id is null or length(sender_id) <= 11)
);
create trigger messages_touch before update on messages for each row execute function app_touch_updated_at();

create index messages_user_idx     on messages (user_id, created_at desc);
create index messages_status_idx   on messages (status, created_at) where status in ('queued','sending');
create index messages_provider_idx on messages (provider_message_id) where provider_message_id is not null;
create index messages_brin         on messages using brin (created_at);

-- Deferred FK: phone_verifications.message_id points at the SMS that carried the OTP.
alter table phone_verifications
  add constraint phone_verifications_message_fk
  foreign key (message_id) references messages(id) on delete set null;


comment on table messages is
  'Every SMS we send, with its delivery outcome. dedupe_key is the mechanism that stops a customer getting four "your plan expires in 2 days" messages when the reminder job retries — the job computes a deterministic key and the unique index does the rest.
  DELIVERY REPORTS: Arkesel POSTs (query params sms_id + status) to the callback_url we pass, IN BATCHES, and the endpoint is UNAUTHENTICATED by design. So the handler must look sms_id up in provider_message_id and reject anything unknown; it must never trust a status for a message it did not send. That is the whole security model of the delivery callback and it is easy to get wrong.';


-- ============================================================================
-- 10. SCHEDULER, AUDIT, BACKUP
-- ============================================================================

create table jobs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null,                              -- 'reminder.expiry_d2', 'subscription.expire', ...
  dedupe_key     text unique,                                -- prevents double-scheduling
  payload        jsonb not null default '{}'::jsonb,
  run_at         timestamptz not null,
  status         text not null default 'pending'
                 check (status in ('pending','claimed','running','done','failed','cancelled')),
  priority       int not null default 100,                   -- lower = sooner
  attempts       int not null default 0,
  max_attempts   int not null default 5,
  backoff_seconds int not null default 60,
  locked_by      text,
  locked_at      timestamptz,
  lock_expires_at timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  last_error     text,
  site_id        uuid references sites(id) on delete cascade,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger jobs_touch before update on jobs for each row execute function app_touch_updated_at();

create index jobs_due_idx on jobs (status, run_at, priority)
  where status in ('pending','claimed','running');
create index jobs_kind_idx on jobs (kind, run_at desc);

comment on table jobs is
  'A Postgres-backed work queue (SELECT ... FOR UPDATE SKIP LOCKED). Deliberately NOT Redis/BullMQ: one fewer service to run, one fewer thing to lose state in, and the queue is transactional with the business data it acts on — an order cannot be committed without its reminder job in the same transaction. Vercel Cron hits /internal/cron/tick every minute to drain it; a second worker is safe because SKIP LOCKED serialises claiming. Kinds: reminder.expiry_d2, reminder.expiry_d0, subscription.expire, subscription.grace_end, order.expire_abandoned, payment.poll_pending, usage.rollup, revenue.rollup, radius.reconcile, settlement.reconcile, sms.delivery_sync, retention.purge_login_attempts, retention.purge_usage, backup.verify.';


create table audit_log (
  id           bigserial,
  actor_type   text not null
               check (actor_type in ('admin','customer','reseller','system','webhook','edge_node','cron')),
  actor_id     text,
  actor_label  text,                                         -- denormalised for readability after a delete
  action       text not null,                                -- 'subscription.extend', 'plan.update', ...
  entity_type  text,
  entity_id    text,
  site_id      uuid,
  changes      jsonb not null default '{}'::jsonb,           -- { field: { old, new } }
  reason       text,
  severity     text not null default 'info'
               check (severity in ('info','notice','warning','critical')),
  ip           inet,
  user_agent   text,
  request_id   text,
  created_at   timestamptz not null default now(),
  primary key (id, created_at)
);
create index audit_log_entity_brin on audit_log using brin (created_at);
create index audit_log_entity_idx  on audit_log (entity_type, entity_id, created_at desc);
create index audit_log_actor_idx   on audit_log (actor_type, actor_id, created_at desc);
create index audit_log_action_idx  on audit_log (action, created_at desc);

comment on table audit_log is
  'Append-only change log for every write that matters, kept for 7 years (Ghana Revenue Authority / commercial dispute horizon) and never UPDATEd or DELETEd by application code — the role running the app has no DELETE grant on this table. The (id, created_at) composite PK is what makes future monthly RANGE partitioning a mechanical operation. Every money-touching action records reason, which turns "why did you give this man free data?" from an argument into a query.';


create table backup_runs (
  id            uuid primary key default gen_random_uuid(),
  target        text not null
                check (target in ('supabase_primary','edge_radius_db','object_store','config_export')),
  kind          text not null check (kind in ('pitr_snapshot','daily_snapshot','pg_dump','wal_archive','routeros_backup')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                check (status in ('running','success','failed','partial','skipped')),
  size_bytes    bigint,
  object_count  bigint,
  destination   text,                                        -- 'supabase-pitr' / 'r2:wavly-backups' / 'usb:nkawie'
  destination_uri text,
  checksum      text,                                        -- sha256 of the dump, so a restore is verifiable
  encryption    text,                                        -- 'age:<recipient>' / 'supabase-managed'
  postgres_lsn  text,
  triggered_by  text not null default 'cron',
  error         text,
  restored_at   timestamptz,
  restore_tested_at timestamptz,                             -- a backup that has never been restored is a rumour
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger backup_runs_touch before update on backup_runs for each row execute function app_touch_updated_at();
create index backup_runs_target_idx on backup_runs (target, started_at desc);

comment on table backup_runs is
  'Backup bookkeeping for BOTH databases plus the router config export. restore_tested_at is the column that matters: a nightly job does a real restore of the latest edge dump into a scratch schema and records it, because the failure mode that ends this business is not "the backup failed" (that alerts) — it is "the backup has been silently broken for four months" (that does not). Retention: 35 daily, 12 weekly, 12 monthly for the cloud DB; 14 daily for the edge; /export of the MikroTik config on every change.';


-- ============================================================================
-- 11. VIEWS used by the dashboard & the edge sync agent
-- ============================================================================

-- What the edge node needs in order to authorise a user, flattened.
create or replace view v_radius_authorization as
select
  u.id                                   as user_id,
  u.username,
  u.phone_e164,
  u.phone_local,
  u.status                               as user_status,
  u.mac_binding_enabled,
  coalesce(u.max_devices_override, s.snapshot_max_simultaneous_devices) as simultaneous_use,
  s.id                                   as subscription_id,
  s.status                               as subscription_status,
  s.starts_at,
  s.expires_at,
  s.grace_ends_at,
  s.snapshot_data_cap_bytes              as data_cap_bytes,
  s.data_used_bytes,
  p.code                                 as plan_code,
  p.name                                 as plan_name,
  rp.name                                as rate_profile_name,
  rp.download_kbps,
  rp.upload_kbps,
  s.snapshot_fup_rate_profile_id         as fup_rate_profile_id,
  frp.download_kbps                      as fup_download_kbps,
  frp.upload_kbps                        as fup_upload_kbps,
  s.updated_at                           as sub_updated_at,
  u.updated_at                           as user_updated_at
from users u
join subscriptions s on s.id = u.active_subscription_id
join plans p         on p.id = s.plan_id
join rate_profiles rp on rp.id = s.snapshot_rate_profile_id
left join rate_profiles frp on frp.id = s.snapshot_fup_rate_profile_id
where s.status in ('active','fup_throttled')
  and u.status = 'active'
  and u.deleted_at is null;

comment on view v_radius_authorization is
  'The single query the edge sync agent polls/subscribes to. Everything FreeRADIUS needs to say yes or no and to build a Mikrotik-Rate-Limit attribute is here, pre-joined and pre-resolved, so the agent does not have to understand the business schema and a plan edit propagates in one round trip.';


create or replace view v_customer_account as
select
  u.id, u.username, u.phone_e164, u.phone_local, u.first_name, u.status,
  u.preferred_language, u.wallet_pesewas, u.total_paid_pesewas,
  u.mac_binding_enabled,
  s.id                            as subscription_id,
  s.status                        as subscription_status,
  s.snapshot_name                 as plan_name,
  p.code                          as plan_code,
  s.starts_at,
  s.expires_at,
  s.grace_ends_at,
  s.snapshot_data_cap_bytes       as data_cap_bytes,
  s.data_used_bytes,
  case when s.snapshot_data_cap_bytes is null then null
       else greatest(0, s.snapshot_data_cap_bytes - s.data_used_bytes)
  end                             as data_remaining_bytes,
  case when s.expires_at is null then null
       else greatest(0, extract(epoch from (s.expires_at - now()))::bigint)
  end                             as seconds_remaining,
  s.auto_renew,
  rp.download_kbps, rp.upload_kbps, rp.label as speed_label,
  (select count(*) from user_devices d where d.user_id = u.id and d.status = 'allowed') as allowed_devices,
  s.snapshot_max_registered_devices as max_devices
from users u
left join subscriptions s on s.id = u.active_subscription_id
left join plans p         on p.id = s.plan_id
left join rate_profiles rp on rp.id = s.snapshot_rate_profile_id
where u.deleted_at is null;

comment on view v_customer_account is
  'Exactly the shape of the customer account page: remaining data, remaining time, expiry, speed, device count. One round trip, no N+1, and the two "remaining" calculations are done in SQL so the portal template cannot get them wrong.';


create or replace view v_active_subscribers as
select
  s.site_id,
  count(*)                                                        as active_subscriptions,
  count(*) filter (where s.status = 'fup_throttled')               as throttled,
  count(*) filter (where s.expires_at < now() + interval '2 days') as expiring_within_2_days,
  count(*) filter (where s.expires_at < now())                     as expired_not_yet_closed,
  sum(s.data_used_bytes)                                           as bytes_used_total,
  sum(s.snapshot_price_pesewas)                                    as contracted_pesewas
from subscriptions s
where s.status in ('active','fup_throttled')
group by s.site_id;

comment on view v_active_subscribers is 'Per-site live subscriber counts for the dashboard header tiles.';


-- ============================================================================
-- 12. ROW LEVEL SECURITY
-- ============================================================================
-- Supabase runs every connection under one of three Postgres roles. Locking this
-- down here means a leaked anon key cannot read customer data even if an API
-- route forgets a WHERE clause. The application connects as `service_role`
-- (bypasses RLS) ONLY from server-side code that has already authenticated the
-- caller; the edge node connects with its own role that can see just the
-- radius views and the usage ingest function.
-- ============================================================================

alter table users                     enable row level security;
alter table user_devices              enable row level security;
alter table subscriptions             enable row level security;
alter table subscription_events       enable row level security;
alter table usage_records             enable row level security;
alter table usage_daily               enable row level security;
alter table orders                    enable row level security;
alter table payment_attempts          enable row level security;
alter table payment_events            enable row level security;
alter table refunds                   enable row level security;
alter table receipts                  enable row level security;
alter table vouchers                  enable row level security;
alter table voucher_batches           enable row level security;
alter table messages                  enable row level security;
alter table phone_verifications       enable row level security;
alter table sessions                  enable row level security;
alter table admin_users               enable row level security;
alter table admin_recovery_codes      enable row level security;
alter table audit_log                 enable row level security;
alter table security_events           enable row level security;
alter table login_attempts            enable row level security;
alter table wallet_entries            enable row level security;
alter table api_tokens                enable row level security;
alter table settings                  enable row level security;

-- Default posture: deny everything to anon and authenticated. Only the service
-- role (server-side) and the edge role see data, via explicit grants below.
-- NOTE: no permissive policies are created for `anon` / `authenticated`.
-- The portal is server-rendered and talks to the DB through the API only.

revoke all on all tables in schema public from public;


-- ============================================================================
-- 13. SCHEMA VERSION BOOKKEEPING
-- ============================================================================

create table if not exists schema_migrations (
  version     text primary key,
  name        text not null,
  applied_at  timestamptz not null default now(),
  checksum    text,
  applied_by  text,
  duration_ms int
);

insert into schema_migrations (version, name, applied_by)
values ('0001', 'initial cloud schema', current_user)
on conflict (version) do nothing;

commit;

-- ============================================================================
-- END OF MIGRATION 0001
-- ============================================================================
