# Roadmap & Phase Plan

Nine deliverables, eight phases. Each phase ends with something you can inspect, and work
stops for your confirmation before the next one starts.

The full testing checklist and rollout plan is **Phase 8**. This document is the map, not the
plan — it exists so you can see what is coming and object early.

---

## Phase map

| Phase | Deliverable | Produces | Depends on | Est. |
|---|---|---|---|---|
| **1** | Architecture + tech stack (brief #1)<br>Database schema (brief #2) | `docs/01`, `docs/02`, `docs/decisions.md`, `docs/schema-reference.md`, `db/migrations/000{1,2}`, `db/seed/0001`, validation tooling + 15 tests | — | ✅ done |
| **2** | MikroTik RouterOS v7 config script (brief #3) | `deploy/mikrotik/` — hotspot, RADIUS client, `/radius incoming` for CoA, walled garden, address lists, DoH block, parent queue, rate-limit rendering, two-VLAN isolation, the local `activate.html`, backup/export script | 1 | 1 day |
| **3** | FreeRADIUS setup and config (brief #4) | `deploy/edge/` — `radiusd.conf`, `mods-available/sql` (PostgreSQL + `read_clients`), the `postauth` password-redaction override, `sites-available/default` with the MAC-binding and expiry policies, `clients.conf` generation, dictionary, systemd unit, a `radtest` harness | 1, 2 | 1 day |
| **4** | Edge node: `syncd` + activation handshake *(new component — forced by CGNAT, no matching item in the brief)* | `edge/` — Supabase Realtime subscriber, long-poll fallback, full reconcile, projection writer, CoA originator, idempotent usage uplink, degraded-mode logic, the LAN token-exchange endpoint, local `pg_dump` + off-site copy, heartbeat | 1, 3 | 2 days |
| **5** | Backend (brief #5) | `app/` — Express + TS, repositories, OTP auth, plans, checkout, Paystack client, webhook handler, voucher generation/redemption/export, receipts, refunds, jobs worker, cron tick, rate limiting, CSRF, audit middleware, `scripts/create-admin.mjs` | 1, 4 | 3 days |
| **6** | Portal + admin dashboard (brief #6) | `app/views/` — captive portal (redirect target, login, signup+OTP, plan list, MoMo checkout with countdown, account, usage history, renew, voucher redeem, privacy notice) and admin (login + TOTP enrolment, dashboard tiles, users, plans, vouchers + CSV/PDF, payments, refunds, resellers, reports, settings, network-rule renderer, audit log) | 5 | 3 days |
| **7** | Deployment guide (brief #7) | `docs/07-deployment.md` + `deploy/` — Vercel project, Supabase project, domain + Cloudflare DNS/TLS/WAF, how the cloud reaches the site given CGNAT (answer: it never does — outbound only), edge node provisioning script, UPS/power, Starlink dish placement, backup and restore runbooks, monitoring and alerting, cost sheet | 6 | 1 day |
| **8** | Testing checklist + phased rollout (brief #8) | `docs/08-testing-and-rollout.md` + `docs/08-security.md` — unit/integration tests, a payment-simulator harness, on-site acceptance tests with real handsets, load and failure-injection drills (pull the Starlink cable, kill the edge node), security review against Act 843, and the MVP→full rollout schedule with go/no-go gates | 7 | 1 day |

**~12 working days** of build, assuming decisions D1–D14 in `docs/decisions.md` are settled and
hardware is on site.

---

## The MVP cut

The brief asked for MVP first, then extras. Here is the line, drawn so that **the MVP is a
complete business** — you can open for trade and take money on day one — and everything after
it is an improvement rather than a missing organ.

### MVP (Phases 1–6, reduced scope)

| Feature | In MVP? |
|---|---|
| Auto-redirect to portal on connect | ✅ |
| Phone + OTP signup and login | ✅ |
| Plan list with prices, speeds, caps | ✅ |
| Paystack MoMo push (MTN + Telecel + AirtelTigo) | ✅ |
| Verified, idempotent webhook → instant activation, no manual step | ✅ |
| Activation handshake so the device connects without typing anything | ✅ |
| Account page: remaining time/data, expiry, usage history, renew | ✅ |
| Auto-disconnect on expiry + friendly renew page | ✅ |
| Time-based, data-based and combined plans with per-plan speed limits | ✅ |
| Vouchers: bulk generate, CSV export, used/unused tracking, redeem | ✅ |
| Payment records, on-screen + SMS receipts, failed-payment handling | ✅ |
| Expiry reminders: T−2 days and T−0 | ✅ |
| Multiple devices per account, configurable limit | ✅ |
| Admin dashboard: active users, revenue daily/weekly/monthly, bandwidth, top users | ✅ |
| Manage users/plans/vouchers/payments; extend, suspend, ban | ✅ |
| CSV export of every report | ✅ |
| Per-user bandwidth limits and fair-usage throttling | ✅ |
| HTTPS everywhere, argon2id, rate limiting, CSRF, webhook signature verification | ✅ |
| Daily backups of both databases + restore test | ✅ |
| Audit log | ✅ |
| Privacy notice on the portal, minimal collection | ✅ |
| Voucher **PDF** export (print-ready A4 sheet) | ✅ *— cheap, and vouchers are the cash path* |

### Deliberately after MVP

| Feature | Why deferred |
|---|---|
| **Refunds via Paystack** | MVP ships *wallet credit* refunds only — instant, free, and the remedy customers actually accept for a GH¢5 duplicate charge. Provider refunds need the two-admin approval UI and settlement reconciliation. `refunds` table already supports both. |
| **MAC binding enforcement** | Schema, seed and edge policy are all in place; the *admin UI* to review pending devices comes later. Turning it on before customers know about iOS/Android private-MAC randomisation generates support calls, not security. |
| **Site block/allow rules** | Seeded with the DoH blocklist and walled garden (which are what actually matter). The dashboard editor and the "apply to router" diff come later. |
| **Reseller/agent accounts with commission** | Explicitly Phase 2 in the brief. Tables, ledger and payout schema are already built so it needs no migration. |
| **Add-ons** (extra GB, extra days, extra device slot) | Highest-value upsell, but it needs the wallet and the account page to be solid first. |
| **Settlement reconciliation** | Valuable once volume justifies it. Tables exist. |
| **Email receipts / statements** | SMS and on-screen cover the actual need. |
| **Twi-language portal** | `users.preferred_language` and `message_templates.locale` already support it; the copy needs a native reviewer, not an engineer. |
| **Second site** | Nothing to build — `site_id` is already everywhere. Insert a row. |

---

## Decisions needed from you, and when

| # | Decision | Blocking | Needed by |
|---|---|---|---|
| 1 | **Starlink plan and its data allowance** | Caps and fair-usage thresholds | Before Phase 6 goes live — not before it is built |
| 2 | Real domain name (or keep the `wavlywifi.com` placeholders) | MikroTik `dns-name`, walled garden, TLS certs, SMS links | **Phase 2** |
| 3 | Arkesel sender ID registration (`WAVLY`?) | All SMS | Phase 5 |
| 4 | Paystack live keys + business verification | Real money | Phase 5 |
| 5 | Edge node hardware: N100 mini PC vs Raspberry Pi 4 | Provisioning script | Phase 4 |
| 6 | MikroTik model on site (assumed hAP ax3) | Phase 2 script comments | **Phase 2** |
| 7 | Whether the portal and admin share a hostname or split | TLS + firewall rules | Phase 2 |
| 8 | Tax status (VAT/NHIL/GETFund registration) | `plans.tax_percent` | Phase 6 |
| 9 | Data Protection Commission registration | Legal, not technical | Before taking subscribers |

Everything is env- or settings-driven, so a late answer to #2 or #6 is a config change, not a
rewrite.

---

## Progress

- [x] **Phase 1** — architecture, tech stack, database schema, seed data, SQL validation and
      structural checking tooling, decision log, generated schema reference.
- [ ] Phase 2 — MikroTik RouterOS v7 configuration
- [ ] Phase 3 — FreeRADIUS
- [ ] Phase 4 — edge node / `syncd`
- [ ] Phase 5 — backend
- [ ] Phase 6 — portal + admin
- [ ] Phase 7 — deployment
- [ ] Phase 8 — testing + rollout
