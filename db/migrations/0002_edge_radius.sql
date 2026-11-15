-- ============================================================================
--  Wavly WiFi — EDGE NODE database (on-site local PostgreSQL)
--  Migration 0002 — FreeRADIUS rlm_sql schema + sync machinery
-- ----------------------------------------------------------------------------
--  THIS FILE DOES NOT RUN ON SUPABASE. It runs on the small Linux box sitting
--  next to the MikroTik in Nkawie. See docs/01-architecture.md §1.2 for why the
--  edge node owns authentication.
--
--  Why a second database at all
--  ----------------------------
--  1. CoA. RFC 3576 Disconnect-Request / CoA-Request are sent BY the RADIUS
--     server TO the router on UDP 3799. Starlink puts the site behind CGNAT, so
--     nothing on the internet can originate a packet to the MikroTik. Only a
--     RADIUS server on the same LAN can disconnect a user the instant their plan
--     expires or throttle them mid-session.
--  2. Availability. If authentication depended on a cloud round trip, every
--     Starlink outage would also lock paying customers out of Wi-Fi they have
--     already bought.
--  3. Latency. Local lookup is <1 ms; cloud is 150-250 ms per query, and one
--     Access-Request triggers several.
--
--  --------------------------------------------------------------------------
--  IMPORTANT: the rad*/nas tables below reproduce the OFFICIAL FreeRADIUS 3.0.x
--  PostgreSQL schema
--    raddb/mods-config/sql/main/postgresql/schema.sql
--  verbatim, because the stock queries in
--    raddb/mods-config/sql/main/postgresql/queries.conf
--  name those columns exactly. Do not "tidy" them.
--
--  A widely-copied variant writes `create index radcheck_username on
--  radcheck(username(32))`. That is MYSQL prefix-index syntax. PostgreSQL PARSES
--  it (as a call to a function named username) and then fails at CREATE time with
--  "function username(integer) does not exist". The official schema indexes
--  (UserName, Attribute) with no prefix length, which is also the index the stock
--  authorize query actually wants. Use that.
--  --------------------------------------------------------------------------
--
--  Column names are written lower-case. PostgreSQL folds unquoted identifiers to
--  lower case anyway, so `UserName` and `username` are the same column — the
--  official schema's mixed case is cosmetic. Keeping them lower-case here avoids
--  every query needing double quotes.
--
--  The `edge_*` tables are ours and are never replicated to the cloud except as
--  aggregates and heartbeats.
--
--  Requires PostgreSQL 13+.
--    sudo -u postgres createuser -P radius
--    sudo -u postgres createdb -O radius wavly_edge
--    psql -U radius -d wavly_edge -f db/migrations/0002_edge_radius.sql
-- ============================================================================

begin;

create extension if not exists pgcrypto;   -- gen_random_uuid() for sync_outbox.origin_id

-- ============================================================================
--  STOCK FREERADIUS TABLES  (do not rename or retype these)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- radacct — live accounting
-- ----------------------------------------------------------------------------
create table if not exists radacct (
  radacctid           bigserial primary key,
  acctsessionid       text not null,
  acctuniqueid        text not null unique,
  username            text,
  groupname           text,          -- present in some FreeRADIUS 3.x schema revisions; harmless, keep for compat
  realm               text,
  nasipaddress        inet not null,
  nasportid           text,
  nasporttype         text,
  acctstarttime       timestamp with time zone,
  acctupdatetime      timestamp with time zone,
  acctstoptime        timestamp with time zone,
  acctinterval        bigint,
  acctsessiontime     bigint,
  acctauthentic       text,
  connectinfo_start   text,
  connectinfo_stop    text,
  acctinputoctets     bigint,
  acctoutputoctets    bigint,
  calledstationid     text,
  callingstationid    text,
  acctterminatecause  text,
  servicetype         text,
  framedprotocol      text,
  framedipaddress     inet,
  framedipv6address   inet,
  framedipv6prefix    inet,
  framedinterfaceid   text,
  delegatedipv6prefix inet,
  class               text
);

-- Exactly the indexes the stock queries.conf expects.
-- radacct_active_session_idx backs the update/stop/simul_count queries.
create index if not exists radacct_active_session_idx on radacct (acctuniqueid) where acctstoptime is null;
-- radacct_bulk_close backs the "close sessions left open by a NAS reboot" query.
create index if not exists radacct_bulk_close on radacct (nasipaddress, acctstarttime) where acctstoptime is null;
-- radacct_start_user_idx backs common statistics queries.
create index if not exists radacct_start_user_idx on radacct (acctstarttime, username);
-- Used by simul_verify_query, which looks up open sessions by user on a NAS.
create index if not exists radacct_active_user_idx on radacct (acctsessionid, username, nasipaddress);
-- Used by the stop query and by usage uplink sweeps over closed sessions.
create index if not exists radacct_stop_user_idx on radacct (acctstoptime, username);
-- NOTE: the official schema also carries a COMMENTED-OUT
--   create unique index radacct_whoson on radacct (acctstarttime, nasipaddress);
-- It stays out deliberately. A UNIQUE index there would reject the accounting
-- INSERT whenever two customers start a session in the same second on the same
-- NAS - which on an 80-user site is a matter of when, not if - silently losing
-- usage records and therefore revenue.
-- radacct_session_idx is likewise omitted: the UNIQUE constraint on acctuniqueid
-- already provides it.
create index if not exists radacct_class_idx on radacct (class);

-- Wavly additions. These are OURS, appended after the stock columns so an
-- upstream schema diff stays readable. Nothing in queries.conf touches them.
alter table radacct add column if not exists wavly_synced_at timestamptz;
alter table radacct add column if not exists wavly_origin_id uuid;
alter table radacct add column if not exists wavly_counter_suspect boolean not null default false;

create index if not exists radacct_unsynced_idx on radacct (acctstarttime) where wavly_synced_at is null;

comment on table radacct is
  'Live RADIUS accounting, stock FreeRADIUS 3.0.x PostgreSQL layout. rlm_sql INSERTs on Accounting-Request Start, UPDATEs on Interim-Update and closes the row on Stop.

  *** THE 4 GiB COUNTER WRAP ***
  MikroTik reports Acct-Input-Octets / Acct-Output-Octets as 32-bit counters that
  wrap at 4294967296, carrying the overflow in Acct-Input-Gigawords /
  Acct-Output-Gigawords. A heavy user on a fast plan crosses 4 GiB in about
  35 minutes at 20 Mbps, so on the GH¢100 plan this is a DAILY event, not an edge
  case. Mishandled, the customer appears to use almost nothing and you silently
  give away hundreds of gigabytes.
  wavly_counter_suspect is set by syncd when the delta between two interim updates
  is negative or implausibly large — i.e. a wrap it could not resolve. Those rows
  are still uploaded (flagged) so the discrepancy is visible rather than hidden.

  wavly_synced_at / wavly_origin_id are the uplink bookkeeping: a row is written to
  sync_outbox in the same transaction it is closed, and origin_id becomes
  usage_records.origin_id in the cloud, where a UNIQUE constraint makes retries
  idempotent across a flaky Starlink link.

  Open sessions (acctstoptime IS NULL) are the truth for "who is online now" and
  for Simultaneous-Use enforcement.';


-- ----------------------------------------------------------------------------
-- radcheck — authorisation CHECK items
-- ----------------------------------------------------------------------------
create table if not exists radcheck (
  id        serial primary key,
  username  text not null default '',
  attribute text not null default '',
  op        varchar(2) not null default '==',
  value     text not null default ''
);
create index if not exists radcheck_username on radcheck (username, attribute);

comment on table radcheck is
  'Conditions that must hold for Access-Accept. Written by syncd from the cloud
  view v_radius_authorization, never by hand. Typical rows per user:
    Cleartext-Password  :=  <phone_local or voucher code>
    Simultaneous-Use    :=  <plans.max_simultaneous_devices>   (1 for most plans)
    Expiration          :=  <subscriptions.expires_at>         "2026-12-15"
    Auth-Type           :=  Reject                             (suspended/banned only)
  The index on (username, attribute) is the one the stock authorize query uses;
  the MySQL-style `username(32)` prefix index seen in copied schemas does NOT work
  on PostgreSQL.';


-- ----------------------------------------------------------------------------
-- radreply — per-user REPLY attributes
-- ----------------------------------------------------------------------------
create table if not exists radreply (
  id        serial primary key,
  username  text not null default '',
  attribute text not null default '',
  op        varchar(2) not null default '=',
  value     text not null default ''
);
create index if not exists radreply_username on radreply (username, attribute);

comment on table radreply is
  'Per-user reply attributes, used only for OVERRIDES: Session-Timeout,
  Idle-Timeout, Mikrotik-Total-Limit (a hard per-session data ceiling),
  Mikrotik-Address-List (for per-user site block/allow rules). The normal path is
  group membership in radusergroup, so this table stays small.';


-- ----------------------------------------------------------------------------
-- radgroupcheck / radgroupreply — group attributes
-- ----------------------------------------------------------------------------
create table if not exists radgroupcheck (
  id        serial primary key,
  groupname text not null default '',
  attribute text not null default '',
  op        varchar(2) not null default '==',
  value     text not null default ''
);
create index if not exists radgroupcheck_groupname on radgroupcheck (groupname, attribute);

create table if not exists radgroupreply (
  id        serial primary key,
  groupname text not null default '',
  attribute text not null default '',
  op        varchar(2) not null default '=',
  value     text not null default ''
);
create index if not exists radgroupreply_groupname on radgroupreply (groupname, attribute);

comment on table radgroupreply is
  'WHERE RATE LIMITING ACTUALLY LIVES. Groups are named after the RATE PROFILE,
  not the plan — e.g. group "rate-12000-6000" carries
      Mikrotik-Rate-Limit = "6M/12M 12M/24M 6M/12M 15s/15s 5"
  Remember rx/tx are from the ROUTER''S point of view: rx = client UPLOAD,
  tx = client DOWNLOAD. A plan sold as "12 down / 6 up" is written "6M/12M".
  Getting this backwards is the most common MikroTik billing bug and it fails
  silently, presenting only as "the internet is slow".

  Also present: group "fup-rate-4000-2000" (fair-usage ceiling) and group
  "suspended" carrying Auth-Type := Reject.

  Because a plan''s speed is group MEMBERSHIP rather than a per-user row, changing
  the speed of 80 customers is one UPDATE here plus 80 CoA packets — not 80 row
  edits, and not 80 chances to get one wrong.';


-- ----------------------------------------------------------------------------
-- radusergroup — membership
-- ----------------------------------------------------------------------------
create table if not exists radusergroup (
  id        serial primary key,
  username  text not null default '',
  groupname text not null default '',
  priority  integer not null default 0
);
create index if not exists radusergroup_username on radusergroup (username);

comment on table radusergroup is
  'User -> group memberships. Higher priority wins when two groups define the same
  attribute, and that is exactly how fair-usage throttling is applied WITHOUT
  deleting the customer''s normal rate group:
    1. syncd inserts (username, ''rate-12000-6000'',   priority 1)   -- the plan
    2. on FUP breach it inserts (username, ''fup-rate-4000-2000'', priority 10)
    3. the FUP ceiling overrides, a CoA reshapes the LIVE session
    4. clearing the FUP is a single DELETE plus another CoA
  Reversible, auditable, and it never loses the customer''s purchased entitlement.';


-- ----------------------------------------------------------------------------
-- nas — RADIUS clients (the MikroTik routers)
-- ----------------------------------------------------------------------------
create table if not exists nas (
  id          serial primary key,
  nasname     varchar(128) not null,
  shortname   varchar(32),
  type        varchar(30) not null default 'other',
  ports       int4,
  secret      varchar(60) not null default 'secret',
  server      varchar(64),
  community   varchar(50),
  description varchar(200) default 'RADIUS Client'
);
create index if not exists nas_nasname on nas (nasname);

comment on table nas is
  'Read by FreeRADIUS when mods-enabled/sql sets `read_clients = yes`, so the
  router list is data rather than a hand-edited clients.conf.

  THE SHARED SECRET EXISTS ONLY HERE AND IN THE ROUTER. The cloud database stores
  nas_devices.shared_secret_ref — a POINTER such as "edge:env:RADIUS_SECRET_NKAWIE01"
  — never the secret itself. A Supabase breach therefore cannot let an attacker
  forge accounting records or inject CoA disconnects into your network.';


-- ----------------------------------------------------------------------------
-- radpostauth — every authentication outcome
-- ----------------------------------------------------------------------------
create table if not exists radpostauth (
  id                bigserial primary key,
  username          text not null,
  -- NEVER a real password. The stock FreeRADIUS post-auth query writes
  -- '%{%{User-Password}:-%{Chap-Password}}' here, i.e. the submitted credential in
  -- cleartext. Under Act 843 that is unnecessary processing of a secret, and a
  -- leaked edge dump would then expose every customer's Wi-Fi password. Our
  -- queries.conf override writes the literal string 'REDACTED'. The column is
  -- kept because the stock schema has it and tooling may expect it.
  pass              text,
  reply             text,
  calledstationid   text,
  callingstationid  text,
  authdate          timestamp with time zone not null default now(),
  class             text
);
create index if not exists radpostauth_username on radpostauth (username, authdate desc);
create index if not exists radpostauth_class_idx on radpostauth (class);

-- ---------------------------------------------------------------------------
-- nasreload — part of the official FreeRADIUS PostgreSQL schema, and the table
-- Phase 1 omitted. Both simul_count_query and simul_verify_query LEFT JOIN
-- against it, and those are precisely the queries that enforce Simultaneous-Use
-- (our max_simultaneous_devices / device-slot limit). Without the table every
-- Access-Request from a plan with a device limit raises a SQL error inside the
-- session section.
--
-- Semantics: when a NAS reboots it loses its session state, so open radacct rows
-- for that NAS are stale. Recording the reload time lets the simul_* queries
-- ignore sessions that started before it. A row is written by the edge node when
-- it detects a NAS restart; absence of a row is handled by the `OR ReloadTime IS
-- NULL` branch in the stock queries.
-- ---------------------------------------------------------------------------
create table if not exists nasreload (
  nasipaddress inet primary key,
  reloadtime   timestamp with time zone not null
);

comment on table nasreload is
  'Official FreeRADIUS table. Records when each NAS last reloaded so the '
  'simul_count_query / simul_verify_query joins can ignore sessions that were '
  'open before the reboot. Required whenever `session { sql }` is enabled, which '
  'is how Simultaneous-Use (the per-customer device limit) is enforced.';
create index if not exists radpostauth_reply    on radpostauth (reply, authdate desc);
create index if not exists radpostauth_brin     on radpostauth using brin (authdate);

comment on table radpostauth is
  'Accepted and rejected authentications — the evidence trail for "it says my
  password is wrong".

  *** DATA PROTECTION — THIS OVERRIDE IS NOT OPTIONAL ***
  The stock FreeRADIUS postauth query writes the SUBMITTED CLEARTEXT PASSWORD into
  the `pass` column. Under the Ghana Data Protection Act 2012 (Act 843) that is
  unnecessary processing of a secret, and a leaked edge database would hand over
  every customer''s Wi-Fi password. In mods-config/sql/main/postgresql/queries.conf
  the post-auth query is overridden to write the literal string ''REDACTED''.
  `pass` is nullable here so that override can also write NULL. Username, reply and
  authdate are retained — that is everything a dispute actually needs.';


-- ============================================================================
--  WAVLY SYNC MACHINERY  (edge-local; never replicated except as aggregates)
-- ============================================================================

create table edge_state (
  id                     int primary key default 1 check (id = 1),   -- singleton
  node_id                uuid not null,
  site_code              text not null,
  cloud_base_url         text not null,
  api_token_prefix       text not null,
  schema_version         text not null,
  downlink_cursor        timestamptz,      -- max(updated_at) applied from the cloud
  downlink_seq           bigint not null default 0,
  last_realtime_msg_at   timestamptz,
  last_long_poll_at      timestamptz,
  last_full_reconcile_at timestamptz,
  uplink_flushed_at      timestamptz,
  uplink_pending_count   bigint not null default 0,
  last_coa_at            timestamptz,
  last_coa_ok            boolean,
  last_heartbeat_sent_at timestamptz,
  degraded               boolean not null default false,
  degraded_since         timestamptz,
  last_error             text,
  updated_at             timestamptz not null default now()
);

comment on table edge_state is
  'Singleton row (id is CHECK-constrained to 1) holding the sync agent''s position
  and health. `degraded` flips true when the cloud is unreachable: authentication
  keeps working from the local cache, new signups and purchases stop, and the cloud
  dashboard shows the site degraded because its heartbeat has gone quiet.
  This row is the difference between "the internet is down" and "the internet is
  down and nobody knows".';


create table sync_outbox (
  id            bigserial primary key,
  origin_id     uuid not null default gen_random_uuid(),  -- becomes usage_records.origin_id
  kind          text not null check (kind in ('usage','auth_event','coa_result','heartbeat',
                                              'device_seen','security','counter_suspect')),
  payload       jsonb not null,
  status        text not null default 'pending'
                check (status in ('pending','sending','acked','failed','dropped')),
  attempts      int not null default 0,
  max_attempts  int not null default 200,
  next_retry_at timestamptz not null default now(),
  last_error    text,
  acked_at      timestamptz,
  created_at    timestamptz not null default now(),
  constraint sync_outbox_origin_unique unique (origin_id)
);
create index sync_outbox_pending_idx on sync_outbox (status, next_retry_at)
  where status in ('pending','sending','failed');
create index sync_outbox_brin        on sync_outbox using brin (created_at);

comment on table sync_outbox is
  'DURABLE UPLINK BUFFER — the write-ahead log that makes an eventually-consistent
  design safe. Accounting is queued here in the SAME transaction it is written to
  radacct, so a session recorded locally can never be lost before upload.

  The agent drains it in batches of `radius.usage_push_batch_size` (200) to
  POST /internal/edge/usage. The cloud dedupes on origin_id, which has a UNIQUE
  constraint on usage_records — so a retry after a Starlink dropout mid-POST cannot
  double-count a customer''s data. Backoff is exponential with jitter, capped at
  15 minutes, up to 200 attempts (~2 days of outage tolerance).

  A three-day outage delays your dashboard. It never loses a billable byte.';


create table sync_downlink_log (
  id            bigserial primary key,
  source        text not null check (source in ('realtime','long_poll','full_reconcile','manual')),
  entity        text not null,
  entity_id     uuid,
  action        text not null check (action in ('upsert','delete','bulk_replace')),
  rows_affected int not null default 0,
  applied_ms    int,
  error         text,
  created_at    timestamptz not null default now()
);
create index sync_downlink_log_brin on sync_downlink_log using brin (created_at);

comment on table sync_downlink_log is
  'What the cloud told us and what we did about it. When a customer says "I paid
  but I am still not connected", this table plus subscription_events in the cloud
  pinpoints which link broke: payment recorded but not synced, synced but CoA
  failed, or CoA sent and the router ignored it. Without it that conversation is
  guesswork.';


create table edge_devices (
  id            bigserial primary key,
  username      varchar(64) not null,
  mac_address   varchar(17) not null,          -- AA:BB:CC:DD:EE:FF, upper case
  status        text not null default 'pending' check (status in ('pending','allowed','blocked')),
  is_bound      boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,
  last_nas      inet,
  cloud_id      uuid,
  updated_at    timestamptz not null default now(),
  constraint edge_devices_unique unique (username, mac_address)
);
create index edge_devices_mac_idx on edge_devices (mac_address);

comment on table edge_devices is
  'Local mirror of the cloud user_devices table, queried by an unlang policy at
  Access-Request time:

    if ("%{sql:SELECT count(*) FROM edge_devices \
         WHERE username=''%{User-Name}'' \
           AND mac_address=UPPER(''%{Calling-Station-Id}'') \
           AND status=''allowed''}" == "0") {
        update control { Auth-Type := Reject }
    }

  Two independent controls:
    * plans.max_registered_devices caps how many rows a username may have;
    * users.mac_binding_enabled / plans.mac_binding_required sets is_bound, which
      makes the policy hard-reject any unregistered MAC. This is the control that
      actually stops one GH¢70 account serving a whole compound.

  NEW MACs are inserted as `pending` and pushed to the cloud via sync_outbox
  (kind=device_seen) so the customer can approve them from the portal — the
  alternative is a support call for every new phone in the household.

  MAC normalisation matters: MikroTik sends Calling-Station-Id lower case with
  colons, iOS randomises MACs per SSID by default, and Android does the same. The
  portal must tell users to disable "private Wi-Fi address" for this network, or
  binding will fight them.';


create table activation_tokens (
  token       text primary key,                 -- opaque, 32 random bytes, base64url
  username    text not null,
  password    text not null,                    -- ephemeral RADIUS credential, never leaves the LAN
  mac_address varchar(17) not null,             -- bound to the device that started the flow
  nas_ip      inet,
  link_orig   text,                             -- where to send the browser after login
  order_id    uuid,
  expires_at  timestamptz not null,             -- 60 seconds
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index activation_tokens_expiry_idx on activation_tokens (expires_at);

comment on table activation_tokens is
  'One-time tokens for the ACTIVATION HANDSHAKE (docs/01-architecture.md §1.7).

  The problem: the HTTPS portal cannot POST credentials to the router''s HTTP
  /login endpoint — browsers block a form submission from an https: page to an
  http: URL as mixed content. Serving the portal over plain HTTP to dodge that
  would put a payment flow on an unencrypted page.

  The solution: the portal does a TOP-LEVEL redirect (allowed) to a tiny
  router-hosted HTTP page carrying only a token. That page exchanges the token for
  credentials at the edge node over the LAN, then submits a SAME-ORIGIN POST to
  /login. Credentials never appear in a URL, never cross the satellite link, and
  exist for 60 seconds. This is what makes "instant activation, no manual step"
  actually work on a phone.

  A purge job deletes expired rows every few minutes; the table never grows.';


create table edge_config (
  key        text primary key,
  value      jsonb not null,
  revision   int not null default 0,
  updated_at timestamptz not null default now()
);

comment on table edge_config is
  'Runtime knobs FreeRADIUS and syncd need WITHOUT a cloud round trip: default
  session/idle timeout, FUP evaluation interval, CoA retry policy, the walled-garden
  revision, and `degraded_mode_auth` — whether to keep authenticating from cache when
  the cloud is unreachable. That one defaults to TRUE deliberately: locking paying
  customers out during a Starlink obstruction event is a worse outcome than a small
  risk of a stale entitlement, and `radius.degraded_mode_max_age_hours` (48) bounds
  that risk so a long outage cannot keep a long-expired account online forever.';


create table edge_schema_migrations (
  version    text primary key,
  name       text not null,
  applied_at timestamptz not null default now(),
  checksum   text
);

insert into edge_schema_migrations (version, name)
values ('0002', 'edge radius schema + sync machinery')
on conflict (version) do nothing;

commit;

-- ============================================================================
-- END OF MIGRATION 0002  (EDGE NODE ONLY — never apply this to Supabase)
-- ============================================================================
