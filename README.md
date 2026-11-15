# wavly-wifi

A **captive portal + hotspot management console** for a voucher-based WiFi network.
Guests get a polished splash page to redeem a voucher or buy a time/data-limited pass;
operators get a dashboard to monitor live sessions, generate voucher batches, tune plans
and configure the hotspot.

Built with **Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · Supabase**,
designed to deploy on **Vercel**.

---

## What's inside

| Route | What it does |
| --- | --- |
| `/` | Guest captive portal — voucher redemption, Mobile-Money-style plan purchase, Terms of Service, connected-state screen |
| `/admin/login` | Password gate for the operator console |
| `/admin` | Overview — KPIs, 7-day activity chart, plan mix, live sessions, activity feed, AP health |
| `/admin/vouchers` | Search/filter vouchers, bulk generate, revoke, copy, CSV export and printable sheets |
| `/admin/sessions` | Live + historical sessions, data usage, time remaining, disconnect devices |
| `/admin/plans` | Create/edit/disable plans (price, validity, data cap, speed, device limit, colour) |
| `/admin/settings` | Hotspot profile, portal copy & ToS, bandwidth limits, router-integration docs |

### Portal flow
Guests can either **enter a voucher code** or **buy a plan**. Buying a pass is a demo
checkout (Mobile Money selector, **no real charge**) that issues a voucher and immediately
connects the device. Both paths require accepting the Terms of Service. A valid voucher is
single-use, single-device, and starts a session with an expiry derived from its plan.

Captive-portal query parameters are honoured: `?mac=…&ap=…&ssid=…` (also `client_mac`,
`apname`), so a router/controller can pass the client's MAC straight into the portal.

> **Try it:** use voucher `WAVLY-DEMO-2026` on the portal (there's a one-click button).

---

## Local development

```bash
npm install
cp .env.example .env.local   # optional — see below
npm run dev
```

Open `http://localhost:3000` for the guest portal and `/admin` for the console.
**Demo console password: `wavly-demo`** (set `ADMIN_PASSWORD` to change it).

### Two data modes

The app works out of the box **without any credentials** in *demo mode*: a realistic seeded
dataset (plans, 78 vouchers, 18 devices, 86 sessions, activity log) lives in
`src/lib/demo.ts` and is mutated in memory. Every screen and action is functional.

Set the two env vars below to switch to **live mode** backed by Supabase Postgres:

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | e.g. `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role / `sb_secret_…` key — **server-side only**, never prefix with `NEXT_PUBLIC_` |
| `ADMIN_PASSWORD` | console password (default `wavly-demo`) |
| `ADMIN_SESSION_SECRET` | salt for the signed session cookie |

All database access goes through Next.js route handlers (`/api/state`, `/api/action`) using
the service-role key. Nothing privileged is ever shipped to the browser and Row Level
Security is enabled on every table.

### Database setup

1. Create/choose a Supabase project, then run [`supabase/migrations/0001_wavly_init.sql`](supabase/migrations/0001_wavly_init.sql)
   in the Supabase SQL Editor.
2. Set the env vars above and restart. On the first request the app **auto-seeds** the
   database with demo plans, vouchers, devices, sessions and events
   (`seedLive()` in `src/lib/store.ts`). [`supabase/seed.sql`](supabase/seed.sql) is an
   optional minimal seed if you'd rather start empty.

All tables use the `wavly_` prefix, so the migration is safe to apply to a Supabase
project that already hosts other applications.

If the database is unreachable the app degrades gracefully to demo mode and shows a
**Demo data** badge in the console.

---

## API

Single `GET` + single `POST` endpoint, both server-side:

```
GET  /api/state                      → full Snapshot (hotspot, plans, vouchers, devices, sessions, events, 7-day usage)
POST /api/action  { type, ... }      → { ok, data?, error? }
```

Action types: `login`, `logout`, `portal.connect`, `portal.purchase`,
`vouchers.generate`, `vouchers.revoke`, `sessions.disconnect`,
`plans.save`, `plans.delete`, `settings.save`.

Example — redeeming a code from a router/controller:

```bash
curl -X POST https://<your-domain>/api/action \
  -H 'Content-Type: application/json' \
  -d '{"type":"portal.connect","code":"WAVLY-DEMO-2026","mac":"A4:83:E7:2B:19:4C","tosAccepted":true}'
```

The console's **Settings → Router integration** panel shows the same snippet.

---

## Deployment

The repo is Vercel-ready (Next.js framework preset, no extra config). Set the same
environment variables on the Vercel project and deploy; Supabase is reached over HTTPS
from the serverless functions.

### Production hardening notes

- The console uses a lightweight HMAC-style password gate for demo purposes. Swap it for
  Supabase Auth (email/OTP + roles) before exposing real customer data.
- Put `/api/action` behind a shared secret when a real router/controller calls it, and
  serve the captive portal over HTTPS with a valid certificate.
- Wire a real payment provider (Paystack/Hubtel MTN MoMo, etc.) before charging guests;
  the current checkout is explicitly a simulation.
- Replace the simulated `bytes_used` / heartbeat values with RADIUS accounting data.

---

## Project layout

```
src/app/                     App Router pages + /api route handlers
src/components/Portal.tsx    Guest captive portal (client)
src/components/admin/        Console shell, context, shared UI, per-page views
src/lib/store.ts             Data layer — Supabase live + in-memory demo fallback
src/lib/demo.ts              Seeded demo dataset & usage aggregation
src/lib/{auth,client,format,types}.ts
middleware.ts                /admin/* auth gate
supabase/migrations/         Schema + RLS
supabase/seed.sql            Optional minimal seed
```
