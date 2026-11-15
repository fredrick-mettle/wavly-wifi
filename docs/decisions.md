# Decision Log

Short, dated records of the choices that are expensive to reverse. Each has the alternative
that was rejected and the reason — so that in six months, when something hurts, you can tell
whether you are hitting a predicted cost or an unanticipated one.

---

## D1 — FreeRADIUS runs on-site, not in the cloud
**Status:** accepted · **Date:** 2026-11-15 · **Reversible:** no (not without losing features)

**Decision.** FreeRADIUS and its database run on a small Linux box on the same LAN as the
MikroTik.

**Why.** RFC 3576 CoA/Disconnect packets are originated *by the RADIUS server toward the
router* on UDP 3799. Starlink CGNAT means nothing on the internet can originate a packet to
the site, so a cloud RADIUS server can never disconnect or re-shape a live session. That
removes instant expiry disconnect, live fair-usage throttling, immediate bans and
`Simultaneous-Use` enforcement.

**Rejected.** Cloud RADIUS pointing at Supabase (loses CoA, and puts 150–250 ms of satellite
latency in every login). All-on-site (loses remote administration and off-site backup, and
there is nowhere public for the Paystack webhook to land).

**Cost accepted.** One more machine to keep alive, on a UPS, and an eventual-consistency window
between cloud and edge.

---

## D2 — The edge keeps a *local* authoritative copy for auth decisions
**Status:** accepted · **Date:** 2026-11-15

**Decision.** FreeRADIUS reads a local PostgreSQL that `syncd` keeps in step with the cloud,
rather than querying Supabase per Access-Request.

**Why.** During a Starlink obstruction event, paying customers must stay online and must be
able to reconnect. With cloud-backed auth, an outage locks out people who have already paid.
Local auth also makes login <1 ms instead of 400–900 ms.

**Rejected.** Direct Supabase queries with a `rlm_cache` fallback — better than nothing, but
the cache is per-process, is lost on restart, and cannot serve accounting.

**Cost accepted.** `syncd` (~400 lines), plus a sub-second staleness window. Bounded by
`radius.degraded_mode_max_age_hours` so a long outage cannot keep a long-expired account
online forever.

---

## D3 — Node.js + Express + TypeScript, not Django
**Status:** accepted · **Date:** 2026-11-15

**Decision.** One Node runtime for the portal, the API, the webhooks and the edge daemon.

**Why.** Two reasons, in order of weight. (1) The architecture requires a long-lived *outbound
websocket* on the edge node for Supabase Realtime; in Node that is a short script with the
official client, in Django it is Channels + Redis + a worker supervisor — two more services on
a box in a hot room for a one-person operation. (2) One language across cloud and edge means
one dependency tree, one linter, one deploy story.

**Rejected honestly.** Django's admin is real and free, and its ORM is better than anything
here. But `django.contrib.admin` is a generic CRUD grid; reshaping it into a GHS revenue
dashboard with two-person refund approval is more work than the five pages actually needed.

---

## D4 — No ORM. Raw SQL, hand-written repositories.
**Status:** accepted · **Date:** 2026-11-15

**Decision.** `pg` + `node-pg-migrate` (plain `.sql` files) + `zod` validation + repository
functions containing literal SQL.

**Why.** This is a billing system. Money movement must be readable SQL you can audit line by
line and run by hand against production while a customer argues about a receipt. Generated SQL
at the point where refunds are decided is a liability.

**Cost accepted.** More typing, no automatic relation loading, and discipline required to avoid
N+1 queries — mitigated by the three views in §2.4 of the schema doc.

---

## D5 — Two databases with a hard, one-directional boundary
**Status:** accepted · **Date:** 2026-11-15

**Decision.** Cloud = authoritative. Edge = derived projection. The edge is never edited by a
human and is fully rebuildable from the cloud by one reconcile pass.

**Why.** Two writable sources of truth is the failure mode that destroys billing systems. One
direction keeps the reconciliation argument tractable: cloud → edge is *state*, edge → cloud is
*metering*, and neither is ever authoritative for the other's domain.

---

## D6 — Money is integer pesewas, never decimal cedis
**Status:** accepted · **Date:** 2026-11-15

**Decision.** `bigint` columns suffixed `_pesewas`. `app_ghs()` formats for display only.

**Why.** Paystack's API takes pesewas. Keeping the same unit end to end means no conversion at
the payment boundary — which is exactly where a rounding bug becomes a refund queue.

---

## D7 — `subscriptions` is a ledger, not a mutable current-plan row
**Status:** accepted · **Date:** 2026-11-15

**Decision.** One row per purchased period, with terms snapshotted at purchase. A partial
unique index enforces at most one `active` row per user.

**Why.** Stacking renewals works from the data model rather than being special-cased; the price
and terms actually sold are preserved; and double-activation from a duplicated webhook is
prevented by the database rather than by application logic that a second server instance would
not share.

**Cost accepted.** Every "what is my plan?" query goes through `users.active_subscription_id`,
a denormalisation that needs a reconciliation job to stay trustworthy.

---

## D8 — Webhook idempotency is built from the payload, not a provider event ID
**Status:** accepted · **Date:** 2026-11-15

**Decision.** `payment_events.dedupe_key = sha256(provider|event|data.id|data.status|data.reference)`
with a UNIQUE index, inserted in its own transaction *before* any business logic runs.

**Why.** Paystack sends no unique event ID and retries on any non-2xx. There is nothing from
the provider to dedupe on. `body_hash` is a second line of defence against a replayed body
under a different event key.

---

## D9 — Job queue in PostgreSQL, not Redis
**Status:** accepted · **Date:** 2026-11-15

**Decision.** `jobs` table + `SELECT … FOR UPDATE SKIP LOCKED`, drained by a Vercel Cron tick
every minute.

**Why.** The decisive property is not performance — it is that the job insert is **transactional
with the business data**. An order cannot commit without its expiry-reminder job. Redis/BullMQ
cannot give that without a two-phase write. It is also one fewer stateful service.

**Cost accepted.** ~60 ticks/hour of latency granularity, and a ceiling around a few thousand
jobs/minute. Both far beyond this business's needs.

---

## D10 — Server-rendered portal, no build step, no CDN assets
**Status:** accepted · **Date:** 2026-11-15

**Decision.** Express + EJS. One small vanilla JS file for the customer portal. HTMX
self-hosted, admin only. All assets served from our own origin. Target <45 kB first paint.

**Why.** Customers arrive over your own constrained satellite uplink *before they have paid*, so
portal bytes compete with paying customers' bytes. A CDN or web-font dependency in the walled
garden is a third-party dependency for your own login page. Every customer action is a plain
HTML form POST that works with JavaScript disabled.

---

## D11 — Customer auth is phone + OTP; admin auth is password + TOTP
**Status:** accepted · **Date:** 2026-11-15

**Decision.** No customer passwords. Argon2id + mandatory RFC 6238 TOTP for admins, with
hashed recovery codes. **No SMS-based 2FA for admins.**

**Why.** The phone number is already the account key and the payment instrument; adding a
password on a shared family phone creates support load for no security gain. Admins can issue
refunds, so a compromised admin account is a direct financial loss — and SIM-swap is common
enough in Ghana that SMS 2FA on the till is not a real control.

---

## D12 — Router config is *rendered*, not pushed live
**Status:** accepted · **Date:** 2026-11-15

**Decision.** `network_rules` and `rate_profiles` are exported as a reviewable RouterOS script;
a human applies it.

**Why.** A bad rule pushed live at 9 pm takes the whole village offline with no rollback. A
diff you read first does not. Automate the push later, once the generator has been right a
hundred times.

---

## D13 — Deviations from the brief, with reasons

The architecture brief was followed except in four places:

1. **`sms.arkesel.com` is *not* in the walled garden.** The brief asked for the SMS domain to
   be allowed. SMS is sent from our server, never from the customer's browser, so opening it to
   unauthenticated clients would hand anyone in radio range a free SMS relay. Paystack *is* in
   the walled garden (hosted checkout fallback). Captive-portal-detection endpoints
   (`captive.apple.com`, `msftconnecttest.com`, `connectivitycheck.gstatic.com`,
   `connectivitycheck.platform.hicloud.com`) were added — without them Android and iOS show
   "no internet" and some handsets refuse to open the login page at all.
2. **FreeRADIUS PostgreSQL schema is reproduced verbatim from the official 3.0.x source**, not
   from the widely-copied variant that uses `create index … (username(32))`. That is MySQL
   prefix-index syntax: PostgreSQL parses it as a call to a function named `username` and then
   fails with `function username(integer) does not exist`.
3. **`radpostauth.pass` never receives a password.** The stock FreeRADIUS query logs submitted
   cleartext passwords. Under Act 843 that is unnecessary processing of a secret, and a leaked
   edge database would expose every customer's Wi-Fi password. `queries.conf` is overridden to
   write `'REDACTED'`.
4. **A third component was added: the edge node.** The brief described a router, a RADIUS
   server and a backend. CGNAT makes "RADIUS server" and "backend" impossible to co-locate, and
   splitting them is what the edge node is.

---

## D14 — Phase 2: the router configuration is rendered from the SQL seed

`deploy/mikrotik/generate.mjs` parses `db/seed/0001_core_defaults.sql` with
`libpg-query` and emits the `.rsc` script plus the hotspot HTML pages.

**Rejected: a second JSON/YAML copy of the same numbers.** Two sources of truth drift, and the
drift is invisible — an admin edits a plan in the dashboard, regenerates nothing, and the router
keeps shaping traffic at last month's rate. **Rejected: requiring a live database.** There is
none at authoring time, the script must be reviewable as a file, and "run psql against
production to generate the config" is how a typo reaches 80 customers.

**Cost accepted:** the seed file is now load-bearing for deployment, not just for first-run
setup. Anything the generator reads must be a literal the parser can evaluate exactly; a `now()`
or `gen_random_uuid()` in one of those columns throws rather than guessing. Foreign keys resolve
to *natural keys* (`p-12-6`), never to invented UUIDs.

`out/` is committed so a plan change shows up as a reviewable diff, matching the
`docs/schema-reference.md` precedent.

## D15 — Phase 2: never push to the router, and never render a secret

The generator has no API client, no SSH and no `--apply` flag. That absence is the design, not
an unimplemented feature: a tool that can reconfigure the router can also cut the only internet
connection a village has, from a laptop that may be 200 km away.

By extension it renders `secret="REPLACE_WITH_RADIUS_SECRET"` and reports the router admin
password as a manual step. `--radius-secret-env VAR` substitutes a real secret but writes to
`*.secret.rsc`, which `.gitignore` excludes, and warns. Settings marked `is_secret` are filtered
out during extraction, before rendering.

**Cost accepted:** applying the config is a manual, human-supervised task with two checks the
generator cannot perform (firewall rule ordering against the factory default chain, and site
queue nesting). Both are called out in the script at the point where they matter.

## D16 — Phase 2: captive-portal detection endpoints stay intercepted

**This reverses a Phase 1 decision**, which had added `captive.apple.com`,
`msftconnecttest.com`, `connectivitycheck.gstatic.com`,
`connectivitycheck.platform.hicloud.com` and `www.apple.com` to the walled garden on the
reasoning that without them Android and iOS show "no internet".

That reasoning is backwards. Those probes are how the phone decides whether to show the sign-in
sheet. They must be intercepted so the probe receives a `302` to our login page instead of its
expected `204`. Allowing them through makes the OS conclude it has real internet, and the sheet
never appears: the customer is on Wi-Fi, has no internet, and sees nothing to fix it.

They are now seeded **inactive** with the reasoning in each row's `notes`, behind
`network.intercept_captive_detection` (default `true`), so a handset that genuinely misbehaves
can be accommodated by flipping a setting and regenerating rather than by hand-editing a live
router.

**Cost accepted:** detection now rests on intercepting plain-HTTP probes plus DHCP option 114
(RFC 8910), which on RouterOS v7 requires `force=yes` — v7 only sends options the client asked
for, and no client asks for code 114.

## D17 — Open decisions still to make

| # | Decision | Needed by | Default if not decided |
|---|---|---|---|
| 1 | Starlink plan and its **data allowance** | Before Phase 6 go-live | Caps stay as seeded; risky — see `docs/01-architecture.md` |
| 2 | Domain registration (`wavlywifi.com`?) | Phase 5 | Placeholder domain, env-driven |
| 3 | Edge node hardware: N100 mini PC vs Raspberry Pi 4 | Phase 4 | Mini PC |
| 4 | Whether to register the DPC data-controller filing yourself or via an agent | Phase 7 | File it yourself |
| 5 | Tax status — VAT/NHIL/GETFund registration threshold | Phase 5 | `billing.tax_percent_default = 0` |
| 6 | MikroTik model and radio naming on site | Phase 8 (acceptance tests) | hAP ax3, `wifi1` = 5 GHz |
| 7 | IANA private enterprise number for `dictionary.wavly`, or drop the vendor block | Before Phase 6 go-live | Placeholder PEN 52381 — harmless while no Wavly attribute goes on the wire, unsafe the moment one does |

## D18 — Phase 3: FreeRADIUS gets its own virtual server, and `default` is deleted

Rather than patching the stock `sites-available/default` (~1300 lines), Phase 3
ships `sites-available/wavly` and removes `sites-enabled/default`.

The stock site loads EAP, LDAP, Perl, Python, `unix` and digest authentication. On
a machine whose LAN is full of people with a financial incentive to get free
internet, `unix` means any shell account on the edge node is also a Wi-Fi
credential, and EAP means an unused TLS handshake endpoint. Deleting `default` also
removes the possibility of two servers racing to bind 1812/1813 — a failure that
presents as "our policies are being ignored".

Listeners bind to `192.168.88.10`, not `*`: harmless today, but a second interface
on this box would otherwise expose authentication to every customer.

**Cost accepted:** no `suffix` realm handling (our usernames are phone numbers and
voucher codes) and no proxying, so a second site cannot be federated through this
node — it gets its own edge node, which is the intended scale path anyway.

## D19 — Phase 3: authorization logic lives in SQL functions, not in unlang

The device roster, its registration side effect and the outbox enqueue are three
PL/pgSQL functions in `db/migrations/0003_edge_radius_logic.sql`
(`wavly_check_device`, `wavly_device_count`, `wavly_queue`), called once each from
`policy.d/wavly`.

The alternative — the same logic in unlang — means string surgery on MAC addresses
and `%{sql: ...}` calls inside `if` conditions, comparing values that are all text.
It would work, and it would be the part of the system nobody dares change in six
months, deciding whether paying customers can log in. SQL gives types,
transactions (`SELECT ... FOR UPDATE`), and a place to write a test.

Two rules inside those functions are load-bearing:

- **No MAC sent → allow.** Never block a customer for a missing attribute. If a
  firmware upgrade stops the router sending `Calling-Station-Id`, device binding
  degrades to cloud-enforced `Simultaneous-Use` and a canary log fills up; the site
  does not go down.
- **Unseen devices are registered `pending` even when rejected**, so a refused
  device is visible in the portal and self-approvable. Without the row it is
  indistinguishable from a broken router.

`wavly_queue` catches constraint violations and returns `NULL` rather than raising,
because a bookkeeping failure must never stop a customer authenticating.

## D20 — Phase 3: expiry disconnects are originated out-of-band by `syncd`

FreeRADIUS 3.x can only send CoA/Disconnect while handling an incoming
Access-Request or Accounting-Request — never on a wall clock, and never if the
request was proxied. Fair usage is therefore easy (interim accounting arrives every
five minutes and we attach a CoA to it), but **subscription expiry has no packet to
hang one on**. Without an out-of-band mechanism, expiry only bites at the
customer's next re-authentication, which for a monthly plan can be days later.

So `deploy/edge/bin/wv-coa` exists: a validated `radclient` wrapper that `syncd`
shells out to, and that an operator can run by hand. Its exit codes separate
**NAK (2)** from **no-reply (3)** because the responses differ — a NAK means our
attributes are wrong and retrying is pointless, a timeout means the CoA path is
broken and retrying is the only fix. An unrecognised reply is never reported as
success, since falsely confirming a disconnect is how a customer stays online for
free for a month.

**Cost accepted:** `syncd` becomes part of the enforcement path, not just
replication. If it is down, expiry stops being enforced in real time (fair usage
still is, locally). That is already true of the whole edge design and is covered by
the stale-heartbeat alert.

## D21 — Phase 3: `read_clients = no` — the RADIUS secret never enters the database

Clients are defined in a generated `clients.conf`, not read from the `nas` table.
With `read_clients = yes` the shared secret lives in a column, and therefore in
every nightly `pg_dump` — including the copy that leaves the site. That dump would
hold the one credential that lets anyone on the LAN authenticate any user, or forge
an Access-Accept.

The `nas` table is still populated, for inventory, the `last_acct_at` heartbeat and
as the CoA target list; its `secret` column stays empty and install step 6c checks
it.

Secrets reach config via `nas_devices.shared_secret_ref`, a **pointer**
(`edge:env:RADIUS_SECRET_NKAWIE01`) resolved at render time. The generator refuses
to run if that column holds a literal, and refuses a secret under 22 characters
(recoverable offline from one captured packet).

**Cost accepted:** adding a router means regenerating `clients.conf` and reloading
FreeRADIUS. That friction is the point — adding a RADIUS client should involve a
human.

## D22 — Phase 3: Message-Authenticator is required in both directions

Blast-RADIUS (CVE-2024-3596) made RADIUS/MD5 responses forgeable by an on-path
attacker. Both directions are configured, and they fail differently:

- **Inbound:** `require_message_authenticator = yes` per client. RouterOS 7.x sends
  it, so this costs nothing. If it ever breaks logins the server says
  `BlastRADIUS check: Received packet without Message-Authenticator` — the fix is a
  router firmware upgrade, **not** setting the flag to `no`.
- **Outbound:** RouterOS **silently drops** replies without it, logging
  `missing message auth, dropping` and telling the customer
  `RADIUS server is not responding`, while FreeRADIUS logs `Login OK` and looks
  healthy. `post-auth` therefore sets `&Message-Authenticator := 0x00` explicitly
  (guarded, so it is never emitted twice). FreeRADIUS ≥ 3.2.5 does this itself, and
  Debian may ship either side of that line; being explicit removes the dependency
  on which point release is installed.

We deliberately do **not** follow upstream's advice that the CoA secret should
differ from the client secret: RouterOS has one secret per RADIUS client entry and
`/radius incoming` uses it for CoA too, so on MikroTik they must match.

## D23 — Phase 3: edge config is templated and rendered, not environment-interpolated

`mods-available/sql` and `clients.conf` are templates with `@@TOKENS@@`, rendered
by `deploy/edge/generate.mjs` from `/etc/wavly/edge.env`. The rendered output goes
to `deploy/edge/local/`, which is gitignored.

FreeRADIUS does support `$ENV{...}` in config files, but support varies by version
and could not be verified against 3.2.x from here, and it has a worse failure mode:
an unset variable expands to an empty string, so `password = ""` is valid config and
the server starts and cannot reach the database. Rendering instead means the
generator can **refuse** to produce a config with an unsubstituted token, a missing
variable, a literal secret, a short secret, or a `coa_server` with no matching
`home_server` — all of which would otherwise be silent outages.

This differs from the MikroTik generator, whose output **is** committed
(`deploy/mikrotik/generated/`), because that output contains no secrets. This one
does, so committing it is not an option and neither is reviewing it in git; the
templates are what you review.
