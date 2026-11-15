# Wavly WiFi

**Captive portal, RADIUS accounting and billing for a community Wi-Fi hotspot in Nkawie,
Ashanti Region, Ghana.**

Backhaul is a Starlink Mini. The gateway is a MikroTik router running hotspot. Customers pay
by Mobile Money (MTN, Telecel, AirtelTigo) or with printed vouchers. Built to start under
100 subscribers and to reach several villages without a rewrite.

---

## Why this looks the way it does

Starlink puts the site behind **CGNAT** — nothing on the internet can open a connection to
Nkawie. That single fact rules out the obvious architecture, because RADIUS
Change-of-Authorisation packets (which are how you disconnect someone the instant their plan
expires, or throttle a live session) travel *from the RADIUS server to the router*.

So: **cloud brain, local muscle.**

```
   Paystack ─┐                            Supabase Realtime (outbound WSS)
   Arkesel  ─┤                                     │
             ▼                                     ▼
   ┌────────────────────┐   usage batches  ┌──────────────────────┐
   │  CLOUD  (Vercel)   │◄─────────────────│  EDGE NODE  (LAN)    │
   │  portal · admin    │   entitlements   │  FreeRADIUS          │
   │  API · webhooks    │─────────────────►│  local PostgreSQL    │
   │  Supabase Postgres │                  │  syncd               │
   │  AUTHORITATIVE     │                  │  ── CoA/Disconnect ──┼──► MikroTik ──► phones
   └────────────────────┘                  └──────────────────────┘
```

A Starlink outage costs you *new signups*. It never locks out customers who have already paid,
and it never loses a billable byte — accounting is buffered on disk and replayed.

Full reasoning, the three topologies that were rejected, and the capacity arithmetic:
**[docs/01-architecture.md](docs/01-architecture.md)**.

---

## Stack

| Layer | Choice | One-line reason |
|---|---|---|
| Gateway | MikroTik, RouterOS **v7** | Hotspot + RADIUS client + per-user queues from RADIUS attributes |
| Auth & accounting | **FreeRADIUS 3.2** on the edge node | Only a LAN RADIUS server can send CoA through CGNAT |
| Backend | **Node.js 22 + Express 5 + TypeScript** | One runtime for cloud *and* edge; the edge needs a persistent outbound websocket |
| Data access | **Raw SQL**, no ORM | Money movement must be auditable line by line and runnable by hand |
| Database | **PostgreSQL 17** (Supabase cloud + local edge) | Partial unique indexes, RLS, `SKIP LOCKED`, BRIN, Realtime |
| Frontend | **Server-rendered EJS**, no build step, <45 kB | Customers arrive on your own satellite uplink *before* paying |
| Payments | **Paystack** (MoMo + hosted-checkout fallback) | Ghana MoMo, pesewas, HMAC-SHA512 webhooks |
| SMS | **Arkesel** | OTP, receipts, expiry reminders |
| Admin auth | Email + argon2id + **mandatory TOTP 2FA** | An admin can issue refunds; SMS 2FA is not a real control here |

---

## Repository layout

```
docs/
  01-architecture.md      Architecture, topology choice, capacity math, degradation matrix
  02-database-schema.md   Schema reasoning, conventions, retention, scale path
  03-mikrotik.md          Router config reasoning: two walled gardens, option 114,
                          the rx/tx inversion, capacity arithmetic, Phase 1 corrections
  04-freeradius.md        Edge RADIUS reasoning: the nasreload bug, the check/reply
                          contract with syncd, CoA origination, Blast-RADIUS both ways
  schema-reference.md     GENERATED — every column of every table (npm run db:docs)
  decisions.md            Decision log: what was chosen, what was rejected, and why
  00-roadmap.md           Phase plan and progress tracker
db/
  migrations/
    0001_initial_cloud.sql   42 tables — cloud, authoritative (Supabase)
    0002_edge_radius.sql     16 tables — edge node, FreeRADIUS + sync machinery
    0003_edge_radius_logic.sql  The SQL the RADIUS policies call: device roster,
                             device count, outbox enqueue, open-session view
  seed/
    0001_core_defaults.sql   Site, 7 plans, 8 rate profiles, settings, SMS templates,
                             DoH blocklist, walled garden, privacy notice
  scripts/
    validate-sql.mjs      Parses SQL against the real PostgreSQL 18 grammar
    check-schema.mjs      Structural checks: FK order/uniqueness, indexes, triggers,
                          views, INSERT arity, ON CONFLICT arbiters
    gen-schema-doc.mjs    Regenerates docs/schema-reference.md from the parse trees
  tests/
    checker.test.mjs      15 regression tests, including false-positive guards
    fixtures/             One known defect each, plus a deliberately correct schema
deploy/mikrotik/
  generate.mjs            CLI: renders the router script from the SQL seed
  lib/
    seed.mjs              Parses db/seed/*.sql with the real PostgreSQL grammar;
                          foreign keys resolve to natural keys, never invented UUIDs
    rate-limit.mjs        Mikrotik-Rate-Limit renderer — the rx/tx inversion lives here
    walled-garden.mjs     network_rules -> L7 / L3 / DNS sinkhole / address list
    render-config.mjs     Assembles the full .rsc script
    hotspot-files.mjs     The HTML pages the router itself serves
  tests/
    router-config.test.mjs  48 regression tests for the silent-failure cases
  generated/              GENERATED, committed so config changes are reviewable diffs
                          (deliberately not out/, dist/ or build/ - those are
                          conventional ignore patterns, and a generated router
                          script nobody can see is one nobody reviews)
    wavly-nkawie-01-router.rsc   The router script (paste section by section)
    hotspot/*.html               login, activate, alogin, error, status
    MANIFEST.md                  What was rendered, warnings, manual steps
```

deploy/edge/
  generate.mjs            CLI: renders the FreeRADIUS config from templates + env;
                          refuses to emit anything with an unsubstituted token, a
                          missing secret, or a CoA destination that does not exist
  bin/wv-coa              Send a CoA / Disconnect. FreeRADIUS can only originate one
                          while handling a request, so subscription expiry needs this
  freeradius/             TEMPLATES, committed, no secrets. Mirrors /etc/freeradius/3.0
    clients.conf.tmpl     Which routers may talk to us; secrets from the environment
    dictionary.wavly      Private attributes (placeholder PEN — see docs/04 §4.15)
    mods-available/sql    PostgreSQL. read_clients = no, so no secret in the database
    mods-available/wavly  MAC-missing canary log + accounting detail file
    mods-config/files/authorize   The one account that works when Postgres is down
    mods-config/sql/…/queries.conf  Upstream v3.2.x, one deviation: REDACTED passwords
    policy.d/wavly        MAC normalisation, device roster, expiry, fair usage
    sites-available/wavly           The virtual server (replaces `default`)
    sites-available/originate-coa.tmpl  Where CoA packets go
  systemd/freeradius.service.d/override.conf   Boot order, restart, hardening
  tests/edge-config.test.mjs  45 tests
  local/                  RENDERED OUTPUT — gitignored, contains secrets

Later phases add `edge/` (the `syncd` daemon) and `app/` (portal + admin).

---

## Verify the schema

No database server needed — the SQL is checked against the real PostgreSQL grammar and then
structurally validated from its parse trees.

```bash
npm install

npm run db:validate   # parses every file in db/migrations and db/seed (330 statements)
npm run db:check      # structural: FK resolution order, uniqueness targets, index and
                      # trigger targets, view sources, INSERT arity, ON CONFLICT arbiters
npm run db:docs       # regenerate docs/schema-reference.md
npm test              # all of the above + 16 schema + 48 router + 45 edge = 109 tests
```

All three scripts **discover** their input files rather than listing them. That is
deliberate: a hardcoded list meant adding `db/migrations/0003` caused the checker and
its own tests to silently skip it while still printing "No structural errors found".

And render the router configuration:

```bash
npm run router:generate   # writes deploy/mikrotik/generated/ (script + hotspot pages)
npm run router:stdout     # prints the script, writes nothing
```

The generator reads the SQL seed, so the router script and the database cannot drift apart.
It exits non-zero on any warning it cannot resolve, because everything that warns here — an
inverted capacity pair, a hotspot `dns-name` colliding with the portal hostname, a non-HTTPS
option 114 URL — produces a configuration that loads cleanly and does not work.

See [`deploy/mikrotik/README.md`](deploy/mikrotik/README.md) before applying it to a router.

And render the edge RADIUS configuration (on the edge node — the output contains secrets, so
it is written to the gitignored `deploy/edge/local/`, never to `generated/`):

```bash
npm run edge:generate -- --env-file /etc/wavly/edge.env
```

See [`deploy/edge/README.md`](deploy/edge/README.md) before installing it.

Then apply for real:

```bash
# Cloud (Supabase)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_initial_cloud.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed/0001_core_defaults.sql

# Edge node — NOT Supabase. Both files, in order: 0002 is the tables
# (stock FreeRADIUS schema plus Wavly sync machinery), 0003 is the functions and
# view the RADIUS policies call. Applying only 0002 gives you a server that starts
# and then fails on every login that touches the device roster.
psql -U radius -d wavly_edge -v ON_ERROR_STOP=1 -f db/migrations/0002_edge_radius.sql
psql -U radius -d wavly_edge -v ON_ERROR_STOP=1 -f db/migrations/0003_edge_radius_logic.sql
```

No admin user is created by the seed. A seed file containing a password is a password in git;
Phase 5 ships `scripts/create-admin.mjs`.

---

## Phase plan

See **[docs/00-roadmap.md](docs/00-roadmap.md)** for the full plan.

| Phase | Deliverable | Your brief | Status |
|---|---|---|---|
| **1** | Architecture + tech stack, database schema | 1 & 2 | ✅ **complete** |
| **2** | MikroTik RouterOS v7 configuration script | 3 | ✅ **complete** |
| **3** | FreeRADIUS setup and config | 4 | ✅ **complete** |
| 4 | Edge node: `syncd`, local projection, CoA, activation handshake | *new — forced by CGNAT* | ⏳ **next** |
| 5 | Backend: auth, plans, payments, webhooks, vouchers | 5 | ⏳ |
| 6 | Portal pages and admin dashboard | 6 | ⏳ |
| 7 | Deployment guide: hosting, domain, SSL, CGNAT connectivity | 7 | ⏳ |
| 8 | Testing checklist and phased rollout plan (MVP first) | 8 | ⏳ |

---

## Things to know before you deploy

1. **Confirm your Starlink plan's data allowance.** 100 users × 100 GB is 3 TB/month. If your
   plan's priority allowance is 50–200 GB you will be deprioritised for most of the month and
   the seeded caps are fiction. This is the largest risk in the business and it is not a
   software problem. → [docs/01-architecture.md §1.3](docs/01-architecture.md)
2. **Put the router and the edge node on a UPS.** They are the only two things keeping paying
   customers online through a power cut, and power cuts are the most common outage here.
3. **Register as a data controller** with Ghana's Data Protection Commission. Act 843 requires
   it. Record the certificate number in `settings.legal.data_protection_registration`.
4. **`rx` is upload and `tx` is download** in `Mikrotik-Rate-Limit` — the attribute is written
   from the *router's* point of view. Getting it backwards produces no error anywhere and
   presents only as "the internet is slow".
5. **RouterOS silently drops RADIUS replies without a `Message-Authenticator`.** FreeRADIUS logs
   `Login OK`, the router logs `missing message auth, dropping`, and every customer sees
   "RADIUS server is not responding". `sites-available/wavly` sets it explicitly in `post-auth`;
   do not remove that block. → [docs/04-freeradius.md §4.7](docs/04-freeradius.md)

---

## License

Proprietary. © Wavly WiFi.
