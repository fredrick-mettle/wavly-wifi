-- ===========================================================================
-- 0003 — Edge RADIUS logic
-- ===========================================================================
-- Runs on the EDGE NODE only, never on Supabase.
--
--   psql -U radius -d wavly_edge -v ON_ERROR_STOP=1 \
--        -f db/migrations/0002_edge_radius.sql
--   psql -U radius -d wavly_edge -v ON_ERROR_STOP=1 -f db/migrations/0003_edge_radius_logic.sql
--
-- These are the functions the FreeRADIUS policies call synchronously during an
-- Access-Request. Two rules shaped them:
--
--   1. ONE round trip on the hot path. Every extra query is latency added to a
--      login on a machine that is also running Postgres, syncd and the RADIUS
--      server. Anything only needed on the reject path is a separate function,
--      because rejects are rare and logins are not.
--   2. The logic lives in SQL, not in unlang. Unlang has no real data types and
--      its string handling is awkward; a device-binding rule written as unlang
--      string surgery is a rule nobody will dare change in six months. Here it is
--      a function with a return type, which can be tested with plain SQL.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- wavly_check_device — the policy that actually stops account sharing.
--
-- Simultaneous-Use only limits sessions that OVERLAP. Two people alternating on
-- one subscription never trip it, and neither does a family of four using the
-- account in shifts. This function is what enforces a per-account device roster.
--
-- Returns exactly one of:
--   'allow'            known device, not blocked
--   'allow_new'        unseen device, registered as 'pending' and let through
--   'reject_blocked'   device is on this account's block list
--   'reject_bound'     the account has MAC binding on, so an unregistered device
--                      may not use it at all
--   'reject_limit'     the account already has max_registered_devices registered
--
-- Side effects (intentional): inserts unseen devices as 'pending' so the customer
-- can self-approve them from the portal, and refreshes last_seen_at. That makes
-- this function the source of truth for "which devices have I actually used",
-- which is also what an admin needs to see when a customer calls about a shared
-- account.
--
-- The MAC is upper-cased here rather than trusted. MikroTik's radius-mac-format
-- is set to XX:XX:XX:XX:XX:XX so it should already be upper case, but a device
-- that cannot authenticate because of letter case is a support call, and the
-- normalisation costs nothing.
-- ---------------------------------------------------------------------------
create or replace function wavly_check_device(
  p_username          text,
  p_mac               text,
  p_max_devices       int,
  p_binding_required  boolean,
  p_nas               inet default null
)
returns text
language plpgsql
as $$
declare
  v_mac      text;
  v_row      edge_devices%rowtype;
  v_count    int;
begin
  -- No MAC to check (a wired client, or a NAS that did not send one). Do not
  -- block the customer for a missing attribute; the cloud can still enforce the
  -- roster on the sessions it sees.
  if p_mac is null or btrim(p_mac) = '' then
    return 'allow';
  end if;

  v_mac := upper(btrim(p_mac));

  select * into v_row
  from edge_devices
  where username = p_username and mac_address = v_mac
  for update;

  if found then
    update edge_devices
       set last_seen_at = now(),
           last_nas     = coalesce(p_nas, last_nas),
           updated_at   = now()
    where id = v_row.id;

    if v_row.status = 'blocked' then
      return 'reject_blocked';
    end if;
    return 'allow';
  end if;

  -- Unseen device. Register it as pending regardless of the outcome, so the
  -- customer can see it in the portal and approve or reject it. A device that is
  -- silently refused with no record is indistinguishable from a broken router.
  insert into edge_devices (username, mac_address, status, is_bound, last_seen_at, last_nas)
  values (p_username, v_mac, 'pending', false, now(), p_nas)
  on conflict (username, mac_address) do update
     set last_seen_at = now(),
         last_nas     = coalesce(p_nas, edge_devices.last_nas),
         updated_at   = now();

  select count(*) into v_count
  from edge_devices
  where username = p_username and status <> 'blocked';

  if p_binding_required then
    return 'reject_bound';
  end if;

  -- The roster limit counts devices, not concurrent sessions. Off by one here in
  -- either direction is a support call, so the comparison is >=: a customer with
  -- max_registered_devices = 3 already has 3 rows and may not add a 4th.
  if p_max_devices is not null and p_max_devices > 0 and v_count > p_max_devices then
    return 'reject_limit';
  end if;

  return 'allow_new';
end;
$$;

comment on function wavly_check_device(text, text, int, boolean, inet) is
  'Per-account device roster enforcement, called from the FreeRADIUS authorize '
  'section. Returns allow / allow_new / reject_blocked / reject_bound / '
  'reject_limit and registers unseen devices as pending so the customer can '
  'self-approve them. This is what actually stops account sharing; '
  'Simultaneous-Use only catches overlapping sessions.';

grant execute on function wavly_check_device(text, text, int, boolean, inet) to radius;

-- ---------------------------------------------------------------------------
-- wavly_device_count — only called on the reject path, to build a message the
-- customer can act on. Kept out of the hot path deliberately.
-- ---------------------------------------------------------------------------
create or replace function wavly_device_count(p_username text)
returns int
language sql
stable
as $$
  select count(*)::int from edge_devices
  where username = p_username and status <> 'blocked';
$$;

grant execute on function wavly_device_count(text) to radius;

-- ---------------------------------------------------------------------------
-- wavly_queue — the single entry point for putting something on the uplink.
--
-- Everything the edge learns and the cloud needs to know goes through
-- sync_outbox, so that a Starlink outage delays delivery instead of losing it.
-- Building that row in unlang would mean assembling JSON by string concatenation
-- inside RADIUS config, which is exactly where an injection or a malformed
-- payload would hide. Doing it here keeps the outbox contract in one place:
-- origin_id for idempotency, sane retry defaults, and a jsonb payload the
-- database validates.
--
-- Returns the origin_id so the caller can correlate.
-- ---------------------------------------------------------------------------
create or replace function wavly_queue(p_kind text, p_payload jsonb)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into sync_outbox (kind, payload)
  values (p_kind, p_payload)
  returning origin_id into v_id;
  return v_id;
exception
  -- A CHECK violation means the caller passed a kind the outbox does not accept.
  -- That is a programming error, and it must not take down authentication: a
  -- customer should not be unable to log in because we failed to log that they
  -- logged in. Report it in the server log and carry on.
  when check_violation or not_null_violation then
    raise warning 'wavly_queue: rejected kind=% payload=%', p_kind, p_payload;
    return null;
end;
$$;

comment on function wavly_queue(text, jsonb) is
  'Enqueue an event for uplink to the cloud via sync_outbox. Returns origin_id, '
  'or NULL if the payload was rejected - a bookkeeping failure must never stop a '
  'customer authenticating.';

grant execute on function wavly_queue(text, jsonb) to radius;

-- ---------------------------------------------------------------------------
-- wavly_open_sessions — the view an admin asks for when a customer says "it says
-- I am already logged in". Simultaneous-Use rejects because of rows here, and
-- these rows are also what go stale when a NAS reboots without sending
-- Accounting-Stop.
-- ---------------------------------------------------------------------------
create or replace view wavly_open_sessions as
select
  a.radacctid,
  a.username,
  a.acctsessionid,
  a.acctuniqueid,
  a.nasipaddress,
  a.callingstationid,
  a.framedipaddress,
  a.acctstarttime,
  a.acctupdatetime,
  a.acctsessiontime,
  (coalesce(a.acctinputoctets, 0) + coalesce(a.acctoutputoctets, 0)) as bytes_total,
  -- A NAS that reloaded invalidates everything it reported before that moment.
  -- The stock simul_* queries use nasreload for the same reason.
  (n.reloadtime is not null and a.acctstarttime < n.reloadtime)      as stale_after_nas_reload,
  age(now(), coalesce(a.acctupdatetime, a.acctstarttime))            as since_last_update,
  a.wavly_synced_at,
  a.wavly_counter_suspect
from radacct a
left join nasreload n on n.nasipaddress = a.nasipaddress
where a.acctstoptime is null;

comment on view wavly_open_sessions is
  'Sessions with no Accounting-Stop yet - i.e. what Simultaneous-Use counts. '
  'stale_after_nas_reload flags rows that predate a NAS reboot and should be '
  'ignored; since_last_update shows how long ago we last heard from the session, '
  'which is how you spot a row that will never close.';

commit;
