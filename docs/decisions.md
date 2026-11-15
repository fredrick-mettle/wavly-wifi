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

## D14 — Open decisions still to make

| # | Decision | Needed by | Default if not decided |
|---|---|---|---|
| 1 | Starlink plan and its **data allowance** | Before Phase 5 | Caps stay as seeded; risky |
| 2 | Domain registration (`wavlywifi.com`?) | Phase 3 | Placeholder domain, env-driven |
| 3 | Edge node hardware: N100 mini PC vs Raspberry Pi 4 | Phase 7 | Mini PC |
| 4 | Whether to register the DPC data-controller filing yourself or via an agent | Phase 7 | File it yourself |
| 5 | Tax status — VAT/NHIL/GETFund registration threshold | Phase 5 | `billing.tax_percent_default = 0` |
