# 1. Architecture & Tech Stack

**Wavly WiFi — captive portal and billing for a community hotspot in Nkawie, Ashanti Region, Ghana.**
Backhaul: Starlink Mini. Gateway: MikroTik (RouterOS v7) hotspot. Target: under 100 concurrent paying users, designed to reach a few thousand across several villages without a rewrite.

---

## 1.1 The recommendation, in one paragraph

> **Cloud brain, local muscle.** The portal, admin dashboard, API, payments, SMS and the
> single authoritative PostgreSQL live in the cloud (Vercel + Supabase). A small Linux box
> on the same LAN as the MikroTik — the **edge node** — runs FreeRADIUS and its own local
> PostgreSQL, and keeps a synced copy of everything needed to say *yes* or *no* to a login.
> The cloud pushes entitlement changes down an outbound websocket; the edge pushes usage
> accounting up in idempotent batches. **No inbound connection to Nkawie is ever required.**

This is not the obvious answer, and it is forced by one hard fact about your internet
connection. The next section explains it.

---

## 1.2 The constraint that decides everything: Starlink CGNAT

Starlink puts you behind Carrier-Grade NAT. You have **no public IPv4 address**, so nothing
on the internet can originate a connection to your site. Outbound connections work normally.

Most hotspot-billing architectures assume the RADIUS server can reach the router. Ours cannot.
Concretely:

| Traffic | Direction | Works from the cloud? |
|---|---|---|
| Router → RADIUS `Access-Request` (UDP 1812) | outbound from site | ✅ yes |
| RADIUS → Router `Access-Accept` | reply on the same UDP flow | ✅ yes (stateful NAT) |
| Router → RADIUS `Accounting-Request` (UDP 1813) | outbound from site | ✅ yes |
| RADIUS → Router **`CoA-Request` / `Disconnect-Request`** (UDP 3799, RFC 3576) | **inbound to site** | ❌ **NO** |
| Paystack webhook → portal | inbound to portal | ✅ if portal is in the cloud |
| You → admin dashboard, from anywhere | inbound to portal | ✅ if portal is in the cloud |

The fourth row is the one that matters. CoA is the only mechanism that lets you:

- **disconnect a user the instant their plan expires** (your requirement 6: "auto-disconnect on expiry");
- **throttle a live session** when they cross the fair-usage threshold, without waiting for them to log in again;
- **kick a session immediately** when you ban an account for abuse;
- **enforce `Simultaneous-Use`** the way MikroTik expects (it disconnects the older session).

Without CoA, expiry only takes effect at the next re-authentication — which, with long
session timeouts, can be hours or days of free service. That is not a detail; at GH¢70/month
with 100 users it is the difference between a business and a charity.

> **Do not plan around IPv6 as an escape hatch.** Starlink does allocate IPv6 on some plans,
> but RouterOS hotspot + RADIUS + CoA over IPv6 through a CGNAT'd satellite link is not
> something to bet a revenue stream on in 2026. Re-test if Starlink Business starts selling
> routable addresses in Ghana; the design below does not depend on it either way.

### Why the three simpler topologies lose

**(A) Everything on one VPS abroad** (portal + Postgres + FreeRADIUS in the cloud, router
points RADIUS at it).
Fails on CoA — no instant disconnect, no live throttling. Also puts two satellite hops in the
login path (router → Starlink → VPS → Postgres) for every Access-Request, and every hotspot
login now fails whenever Starlink has an obstruction event. Rejected.

**(B) Everything on-site** (one box runs portal + Postgres + FreeRADIUS on the LAN).
CoA works, latency is perfect. But: no remote administration — you must be physically in
Nkawie to see whether you made money today; no off-site backup unless you build one; the
Paystack webhook has nowhere public to land, so you would need an inbound tunnel anyway; and
one hot dusty box on unstable mains is a single point of failure for the entire business.
Rejected — though it is the natural *fallback* if cloud costs become a problem.

**(C) Cloud control plane + RADIUS pointing directly at Supabase** (no local database).
Better than A: the edge node is on the LAN so CoA works. But every Access-Request runs
several SQL queries over a 150–250 ms satellite round trip, so a login takes 400–900 ms and
MikroTik's default RADIUS timeout (300 ms) must be raised — which in turn makes a lost
packet cost a full second. Worse, when Starlink drops, **paying customers cannot
re-authenticate**. They are already paid up; they just cannot get online. Rejected.

**(D) Cloud control plane + edge node with a local synced store.** ← chosen
CoA works (LAN). Login is a local query (<1 ms). A Starlink outage costs you *new signups*,
never *existing subscribers*. Accounting is buffered to disk and replayed, so no usage data
is lost. The cost is one extra long-running process and a short eventual-consistency window.

---

## 1.3 Before architecture: is the backhaul big enough?

An architecture that cannot carry the traffic is worthless, so do this arithmetic first.

**A Starlink Mini will realistically sustain 60–150 Mbps down and 10–25 Mbps up in Ghana,
with 15-second-to-2-minute dropouts during rain and obstructions.** Upload is the scarce
resource and it is the one everyone forgets: video calls, WhatsApp video, and TikTok uploads
all push upstream, and 20 Mbps of aggregate upload across 100 users is a hard ceiling.

Two numbers you must check before you sell a single GH¢100 plan:

1. **What is your Starlink plan's data allowance?** Mini/Roam plans in Ghana are sold with a
   priority allowance and then deprioritised, not "unlimited". If you have 100 users each
   consuming 30 GB/month that is **3 TB/month**, and if your plan's priority allowance is
   50–200 GB you will be deprioritised to a crawl for most of the month. *This is the single
   largest risk in the business and it is not a software problem.*
   → **Action: confirm your plan's allowance and fair-use terms in writing before Phase 5.**
2. **Aggregate oversubscription.** The seeded plan ceilings sum to far more than the uplink:
   80 users on Monthly Basic at 12 Mbps each is 960 Mbps of *promise* against ~80 Mbps of
   *reality*. That is 12:1 oversubscription, which is normal and fine for residential
   internet — but only because most users are idle most of the time. It requires:
   - a **parent queue on the MikroTik** capping total site throughput to ~85 % of measured
     capacity, so the satellite link is never saturated (a saturated satellite link has
     catastrophic latency — 500 ms+ — and *everyone's* experience collapses, including yours);
   - **per-plan ceilings** that are a cap, never a guarantee — the portal copy must say
     "up to";
   - **burst** on every profile so a page load feels instant without anyone holding a large
     steady allocation. `rate_profiles` carries exactly these fields, and
     `rate_profiles.total_queue_name` is how a profile is attached to the parent queue.

> The schema deliberately stores `network.upstream_capacity_kbps` as a setting so the
> dashboard can show "site is at 91 % of measured capacity" — the warning that tells you to
> stop selling before customers start complaining.

---

## 1.4 The diagram

```
                                     ┌──────────────────────────────────────────┐
                                     │              CLOUD  (Vercel)             │
                                     │                                          │
   Customer phone ───HTTPS──────────►│   Node.js / Express SSR portal           │
   (on the hotspot,                  │     • /            captive portal         │
    in the walled garden,            │     • /account     usage, renew           │
    before paying)                   │     • /admin       dashboard, 2FA         │
                                     │     • /webhooks/paystack                  │
   Owner's laptop ───HTTPS──────────►│     • /internal/edge/*  (bearer token)    │
   (from anywhere)                   │     • /internal/cron/tick (Vercel Cron)   │
                                     └───────┬───────────────────────▲──────────┘
                                             │                       │
                        Paystack  ──webhook──┘                       │
                        Arkesel   ◄──SMS send────────────────────────┤
                                             │                       │
                                     ┌───────▼───────────────────────┴──────────┐
                                     │        CLOUD DATABASE (Supabase)         │
                                     │  PostgreSQL 17 — AUTHORITATIVE           │
                                     │  42 tables: users, plans, subscriptions, │
                                     │  orders, payment_attempts, payment_events│
                                     │  vouchers, resellers, messages, jobs,    │
                                     │  usage_records, audit_log, ...           │
                                     │  PITR backup on, RLS on, no anon access  │
                                     └───────▲───────────────────────┬──────────┘
                                             │                       │
                        Supabase Realtime ───┘                       │
                        (postgres_changes over WSS)                  │
                                             │                       │
  ══════════════════ STARLINK MINI ══════════╪═══════════════════════╪══════════
        (CGNAT — outbound only, no inbound)  │                       │
                                             │                       │
  ┌──────────────────────── NKAWIE SITE ─────┴───────────────────────┴──────────┐
  │                                                                             │
  │   ┌──────────────────── EDGE NODE (LAN, UPS-powered) ────────────────────┐  │
  │   │  Debian 12 mini PC / Raspberry Pi 4+                                 │  │
  │   │                                                                      │  │
  │   │  ┌────────────────┐   ┌──────────────────┐   ┌────────────────────┐  │  │
  │   │  │  syncd (Node)  │   │    FreeRADIUS    │   │  Local PostgreSQL  │  │  │
  │   │  │                │   │                  │   │   (db: wavly_edge) │  │  │
  │   │  │ • Realtime     │──►│ • authorize      │◄──│ radcheck radreply  │  │  │
  │   │  │   subscriber   │   │ • authenticate   │   │ radgroupreply      │  │  │
  │   │  │ • long-poll    │   │ • accounting     │──►│ radusergroup nas   │  │  │
  │   │  │   fallback     │   │ • Simultaneous-  │   │ radacct            │  │  │
  │   │  │ • full         │   │   Use enforce    │   │ radpostauth        │  │  │
  │   │  │   reconcile    │   │ • CoA originate  │   │ edge_devices       │  │  │
  │   │  │ • usage uplink │   │                  │   │ sync_outbox ◄──────┼──┼──┤ buffered
  │   │  │ • backup dump  │   └────────┬─────────┘   │ edge_state         │  │  │ accounting
  │   │  └───────▲────────┘            │             └────────────────────┘  │  │
  │   │          │                     │ UDP 3799 CoA/Disconnect             │  │
  │   └──────────┼─────────────────────┼────────────────────────────────────┘  │
  │              │                     │                                       │
  │              │            ┌────────▼──────────────────────────────┐        │
  │              │            │      MikroTik  (RouterOS v7)          │        │
  │              │            │                                       │        │
  │              │            │  ether1 ◄── Starlink Mini (WAN/DHCP)  │        │
  │              │            │  bridge: wlan1 + wlan2 + ether2-5     │        │
  │              │            │                                       │        │
  │              │            │  /ip hotspot         (192.168.89.0/24)│        │
  │              │            │  /ip hotspot walled-garden            │        │
  │              │            │  /radius  -> 192.168.88.10 (edge)     │        │
  │              │            │  /radius incoming   (accept CoA)      │        │
  │              │            │  /queue tree  (parent = site ceiling) │        │
  │              │            │  /ip firewall filter (DoH block)      │        │
  │              │            └────────┬──────────────────────────────┘        │
  │                                     │ DHCP + HTTP redirect                  │
  │                             ┌───────▼───────┐                               │
  │                             │  Customer     │  SSID "Wavly WiFi"            │
  │                             │  phones       │  open network, no WPA key     │
  │                             └───────────────┘                               │
  └─────────────────────────────────────────────────────────────────────────────┘
```

**Two networks on site**, because a single flat LAN is how a customer ends up able to reach
your edge node:

- `192.168.88.0/24` — management: MikroTik (`.1`), Starlink Mini, edge node (`.10`). Not
  reachable from the hotspot network except UDP 1812/1813/3799 to `.10`.
- `192.168.89.0/24` — hotspot clients. DHCP lease 1 day. Isolated from management by
  firewall rules, and client-to-client traffic dropped by default.

---

## 1.5 Component responsibilities

| Component | Runs on | Owns | Explicitly does NOT own |
|---|---|---|---|
| **MikroTik hotspot** | Router | DHCP, HTTP interception, redirect, walled garden, per-user queues from RADIUS attributes, CoA execution, the local HTTP fallback login page | Any business logic. It holds no users, no prices, no plans. |
| **FreeRADIUS** | Edge node | Authentication decisions, `Simultaneous-Use` enforcement, MAC-binding policy, accounting collection, **originating CoA** | Pricing, payments, entitlement truth. It reads what `syncd` wrote. |
| **Local Postgres** | Edge node | The stock `rad*` tables + `edge_devices` + `sync_outbox` (a write-ahead log for accounting) | Anything a human edits. It is a projection of the cloud. |
| **syncd** | Edge node | Downlink (Realtime + long-poll + reconcile), uplink (batched, idempotent usage), local `pg_dump`, heartbeat, degraded-mode flag | Deciding who may connect — it copies decisions, it does not make them. |
| **Express app** | Vercel | Portal, admin, API, webhooks, OTP, vouchers, receipts, jobs, rendering the RouterOS config scripts | Direct router access. It can only ever *ask* the edge node to do something. |
| **Supabase Postgres** | Cloud | **The single source of truth** for money and entitlements | Live auth decisions. It is too far away for that. |
| **Vercel Cron** | Cloud | One request per minute to drain the `jobs` queue | Guaranteed timing. `SKIP LOCKED` makes overlapping runs safe. |
| **Paystack** | External | Collecting MoMo money, webhook notification, refunds, settlements | Being right. Every webhook is re-verified against `GET /transaction/verify/:reference`. |
| **Arkesel** | External | Delivering SMS | Being synchronous. Delivery reports arrive batched, late, and unauthenticated. |

---

## 1.6 The five flows that matter

### Flow 1 — New customer, self-service MoMo purchase

```
 1. Phone joins SSID "Wavly WiFi" (open). Gets DHCP on 192.168.89.0/24.
 2. Any HTTP request is intercepted. MikroTik 302-redirects to
      https://portal.wavlywifi.com/?mac=$(mac)&ip=$(ip)&link-orig=$(link-orig-escaped)
    because /ip hotspot profile has html-directory-override set.
    portal.wavlywifi.com is in the walled garden, so this loads before paying.
 3. Portal: enter phone number -> Arkesel sends a 6-digit OTP -> verified ->
    users row created (or matched), a customer session cookie is set.
 4. Plan list rendered from `plans` where is_public, ordered by sort_order.
 5. Customer taps "Monthly Basic — GH¢70", confirms the MoMo number and network.
 6. POST /checkout with an idempotency key. Server computes the price from the
    plans row. NEVER from the request body. orders row created, total pinned by
    the orders_total_ck CHECK constraint.
 7. Server calls Paystack POST /charge with mobile_money{phone, provider}.
    Provider code comes from settings.payments.momo_provider_codes.
    Response is usually pay_offline (MTN, AirtelTigo) or send_otp (Telecel).
 8. Portal shows the operator's own display_text verbatim plus a 180-second
    countdown, and starts polling /orders/:ref/status every 10 s.
 9. Customer approves the prompt on their phone.
10. Paystack sends charge.success to /webhooks/paystack.
      a. Verify x-paystack-signature = HMAC-SHA512(secretKey, RAW BODY). Constant-time.
      b. INSERT into payment_events. The unique dedupe_key is the idempotency gate:
         a redelivery hits a unique violation and we return 200 doing nothing.
      c. GET /transaction/verify/:reference and confirm status=success AND
         amount == orders.total_pesewas AND currency == 'GHS'.
         A mismatch -> security_events(payment_amount_mismatch) and the order is held.
      d. In ONE transaction: order -> paid, receipt issued, subscription inserted
         status='active' (the partial unique index makes a second one impossible),
         reminder jobs scheduled for T-2 days and T-0, wallet/loyalty updated.
      e. Respond 200 to Paystack.
11. Supabase Realtime fires on the subscriptions insert. syncd on the edge node
    receives it in ~100-500 ms, resolves v_radius_authorization for that user, and
    writes radcheck + radusergroup rows into local Postgres.
12. The portal's poll sees status=paid and redirects the browser to the
    ACTIVATION HANDSHAKE (see 1.7). The router logs the device in.
13. SMS receipt: plan, expiry, receipt number. One segment, "GHS" not "GH¢".
```

**Time from MoMo approval to internet: typically 1–3 seconds.** No human anywhere.

### Flow 2 — Returning user logs in

```
1. Device joins the SSID, gets intercepted, lands on the portal.
2. Portal sees a valid session cookie -> goes straight to /account.
3. /account reads v_customer_account: remaining data, remaining time, expiry,
   speed, devices used, renew button.
4. "Connect" -> activation handshake -> router asks the edge FreeRADIUS ->
   radcheck row exists and Expiration is in the future -> Access-Accept with
   Mikrotik-Rate-Limit built from the plan's rate profile -> online.
```
No cloud round trip in the login path. **This still works during a Starlink outage.**

### Flow 3 — Voucher bought at a shop

```
1. Shopkeeper (reseller) or you generate a batch: 200 codes for Weekly at GH¢25.
2. Export CSV or a print-ready PDF (40 codes per A4 sheet, cut lines, QR per code).
3. Customer buys a scratch card anywhere, for cash.
4. On the portal: "I have a voucher" -> type WK1-7QK4-M2XD.
   The check digit is validated locally first (app_voucher_code_valid) so typos
   never reach the database and never count against the guessing rate limit.
5. Conditional UPDATE ... WHERE status='unused' AND version=:v makes double
   redemption impossible even if two people submit the same code simultaneously.
6. Subscription created, edge syncs, activation handshake, SMS receipt.
```
Vouchers are the path that needs **no internet at all** at the moment of sale — which is
why they will probably be most of your revenue in month one.

### Flow 4 — Expiry

```
T-2 days 09:00  jobs(reminder.expiry_d2) -> SMS "expires in 2 days"
T-0     09:00  jobs(reminder.expiry_d0) -> SMS "expires today"
T+0      expiry instant -> jobs(subscription.expire):
                            subscription.status = 'expired'
                            subscription_events('expired')
                            Realtime -> syncd updates radcheck Expiration / adds
                            the 'suspended' rate group
                            syncd sends CoA Disconnect-Request to the MikroTik
                            -> session torn down, browser redirected to /renew
/renew  is in the walled garden, so the customer can renew while disconnected.
T+grace if plans.grace_seconds > 0 the session is kept alive that long first, so
        someone mid-download can finish and renew instead of being cut instantly.
T+1 day jobs(reminder.expired) -> SMS "renew, your login is unchanged"
```

Every message is keyed by `messages.dedupe_key`
(`reminder:expiry_d2:<subscription_id>`), so a retried cron run cannot send it twice.

### Flow 5 — Fair-usage throttle, live

```
1. Edge accounting pushes interim updates every 5 min -> usage_records.
2. A job (or the ingest handler) notices subscription.data_used_bytes has crossed
   fup_threshold_bytes.
3. subscription_events('data_cap_reached'); status -> 'fup_throttled'.
4. Realtime -> syncd inserts radusergroup(username, 'fup-rate-4000-2000', priority=10).
   Priority 10 beats the plan group at priority 1, so the FUP ceiling wins WITHOUT
   deleting the customer's normal rate group. Clearing the FUP is a DELETE.
5. syncd sends CoA-Request with the new Mikrotik-Rate-Limit -> the MikroTik re-shapes
   the LIVE session. The customer is slowed, not disconnected.
6. SMS: "you have used your 100 GB, speed reduced until <expiry>, add data at <url>".
```

Step 5 is impossible in topology A, and that is the entire argument for the edge node.

---

## 1.7 The activation handshake (the genuinely tricky part)

Requirement: *"instant activation after confirmed payment, with no manual step."*

The naive implementation — the HTTPS portal POSTs the RADIUS credentials to the router's
`http://192.168.88.1/login` — **does not work**. A form submission from an `https:` page to
an `http:` URL is blocked as mixed content by Chrome, Safari and Firefox. And serving the
portal over plain HTTP to dodge that would put a payment flow on an unencrypted page, which
is unacceptable.

What does work, and what we build:

```
 HTTPS portal ──302──► http://192.168.88.1/wavly/activate.html?t=<one-time-token>
     (a top-level navigation from https: to http: is ALLOWED — it leaves the secure
      context rather than embedding an insecure subresource in it)

 activate.html is served BY THE ROUTER from its hotspot html-directory. Same origin as
 /login, plain HTTP, tiny, and it works even when Starlink is down. It:

   1. POSTs the token to http://192.168.88.10:8787/activate on the EDGE NODE (LAN,
      one-time, 60-second TTL, bound to the MAC that started the flow).
   2. The edge node looks the token up in local Postgres and returns the RADIUS
      username + password. Credentials never appear in a URL, never cross the
      satellite link, and never touch the cloud after issue.
   3. activate.html submits a SAME-ORIGIN POST to /login with username, password,
      dst=<link-orig> and popup=true. HTTP -> HTTP, no mixed content.
   4. MikroTik sends Access-Request to FreeRADIUS on .10. Accept. Online.
   5. If /login fails, the page shows the local fallback form so the customer can
      type the code by hand — and that path is pure LAN, no cloud involved.
```

The token is written by `syncd` when it applies an activation (downlink) and consumed once.
This adds roughly 60 lines of HTML and 80 lines to the edge daemon, and it is the piece that
makes "no manual step" actually true on a phone.

---

## 1.8 Degradation matrix — what still works when something is down

This table is the real product specification. In an underserved area with a satellite link,
*how it fails* matters more than how it works.

| Failure | Portal | New signup | Existing user logs in | Live users stay online | Expiry disconnect | Usage recorded | Money taken |
|---|---|---|---|---|---|---|---|
| **Everything healthy** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Starlink down** | ❌ | ❌ | ✅ *(edge cache)* | ✅ | ✅ *(local CoA)* | ✅ *(buffered in `sync_outbox`)* | ❌ |
| **Vercel down** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ buffered | ❌ |
| **Supabase down** | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ buffered | ❌ |
| **Edge node down** | ✅ read-only | ⚠️ paid, activates on recovery | ❌ | ⚠️ sessions survive until timeout | ❌ | ❌ router-side only | ⚠️ paid, not activated |
| **MikroTik down** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Paystack down** | ✅ | ⚠️ voucher path still works | ✅ | ✅ | ✅ | ✅ | ❌ *(vouchers yes)* |
| **Arkesel down** | ✅ | ⚠️ OTP blocked | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Mains power down** | ✅ | ✅ | ❌ unless the router+edge are on UPS | ❌ | ❌ | ❌ |

Three deliberate design consequences:

1. **The voucher path is the resilience path.** When Paystack or Arkesel is down you can
   still sell access for cash with a code printed that morning. Do not remove vouchers to
   "simplify" — they are your business continuity plan.
2. **The edge node and the router must be on a UPS.** They are the only two things that keep
   paying customers online through a power cut, and power cuts are the most common outage in
   this environment. A GH¢600 UPS protects a GH¢7,000/month revenue stream. Non-negotiable.
3. **`sync_outbox` is what makes an eventual-consistency design safe.** Accounting is written
   locally in the same transaction as `radacct`, so a three-day Starlink outage delays your
   dashboard but never loses a byte of billable usage.

**Edge node down is the worst case** (paid-but-not-activated). Mitigation: the payment is
recorded and the subscription exists in the cloud, so the customer is never out of pocket;
the portal shows "we're activating your plan, this can take a few minutes" and the entitlement
applies automatically on recovery. `edge_state.degraded` plus a stale heartbeat raises an
alert to the owner's phone.

---

## 1.9 Tech stack, and why

### Backend: **Node.js 22 + Express 5 + TypeScript**, server-rendered

You asked for a choice and a justification. Django is a genuinely good option and I want to
be fair about what it would give up:

| | Node/Express | Django |
|---|---|---|
| Admin UI for free | ❌ build it | ✅ `django.contrib.admin` — but it is a generic CRUD grid, and reworking it into a MoMo/GHS revenue dashboard with refund approval flows is more work than building the five pages you actually need |
| Persistent outbound websocket for Supabase Realtime | ✅ native, no extra infra | ⚠️ needs Django Channels + Redis, i.e. two more services to run on a box in a hot room |
| Serverless on Vercel | ✅ first-class | ⚠️ possible but awkward; Django assumes a long-lived process |
| Async webhooks + polling + long-poll concurrency | ✅ natural fit | ✅ fine with ASGI, more ceremony |
| One language across cloud **and** edge daemon | ✅ | ⚠️ Python is fine too, but then the edge daemon, the portal and the admin are all Python *and* you still need JS for the browser |
| ORM quality for money code | ⚠️ none used — raw SQL | ✅ excellent |

**The decision comes down to two things.** First, the architecture has a long-lived
outbound websocket process on the edge node; in Node that is a 40-line script with the
official `@supabase/realtime-js` client, and in Django it is Channels + Redis + a worker
supervisor. On a one-person operation, every extra service is a thing that can break at
11 pm. Second, one language across the portal, the API, the edge daemon and the RouterOS
config generator means one dependency tree, one linter, one deploy story.

**Deliberately NOT using an ORM.** This is a billing system. Money movement must be readable
SQL that you can audit line by line and run by hand against production when a customer is
arguing about a receipt. We use `pg` (the driver) + `node-pg-migrate` (plain `.sql` files) +
hand-written repository functions + `zod` for input validation. Generated SQL in a system
that decides refunds is a liability, not a convenience.

### Database: **PostgreSQL 17 (Supabase)**, not MySQL

Five features are load-bearing, not decorative:

- **Partial unique indexes** — `unique (user_id) where status='active'` is what guarantees at
  the database layer that a customer can never hold two live plans, even if a webhook is
  delivered twice and two workers race. MySQL cannot express this.
- **Row Level Security** — defence in depth on a database that holds other people's phone
  numbers and payment records.
- **`SELECT ... FOR UPDATE SKIP LOCKED`** — the `jobs` queue. Postgres-as-queue means no
  Redis, no BullMQ, and the job insert is transactional with the order insert: an order
  cannot commit without its reminder job.
- **BRIN indexes** — near-zero-cost indexes on the append-only time-ordered tables
  (`usage_records`, `audit_log`, `payment_events`) that make 10 M+ rows queryable without
  partitioning operations.
- **Supabase Realtime** (`postgres_changes` over WSS) — the downlink to the edge node. It is
  outbound from the site, so CGNAT does not care.

### Frontend: **server-rendered EJS, no build step, one small JS file**

The majority of users are on phones, arriving over your own constrained satellite uplink,
*before they have paid* — so portal bytes compete with paying customers' bytes.

- Target **< 45 kB for the first paint** of the login/plan page, everything included.
- **Zero build step.** No webpack, no Vite, no `node_modules` on the deploy path for the
  frontend. EJS templates render to HTML on the server.
- **Self-hosted assets.** No Google Fonts, no CDN jQuery. A CDN dependency in the walled
  garden is a dependency on a third party for your own login page.
- **Progressive enhancement.** Every customer action is a plain HTML `<form>` POST that works
  with JavaScript disabled. JS is used for exactly three things: the payment-status poll, the
  OTP countdown, and the activation handshake. If JS fails, the customer can still buy.
- **`<meta name="viewport">`, 16 px minimum touch targets, system font stack.** No framework.
- Admin dashboard: same SSR approach + **HTMX served from our own `/assets`** (not a CDN) for
  live-refreshing tables. HTMX is ~14 kB and removes the need for a SPA and its build chain.

### Payments: **Paystack** (confirmed)

`POST /charge` with `mobile_money{phone, provider}`; amounts in **pesewas** (integer minor
units), which matches the schema exactly — no rounding ever crosses the payment boundary.
Provider codes `mtn` / `vod` (Telecel) / `atl` (AirtelTigo). Note that Paystack's own
documentation has listed AirtelTigo as both `atl` and `tgo` over time, so the mapping is
stored in `settings.payments.momo_provider_codes` as **data you can correct without a
deploy**. Verify live codes with `GET /bank?country=ghana&type=mobile_money`.

Webhook: `x-paystack-signature` = HMAC-SHA512 of the **raw request body** with the secret
key. Two traps the schema is built around:

- Paystack sends **no unique event ID** and **retries** on any non-2xx. Idempotency must be
  constructed from the payload: `payment_events.dedupe_key = sha256(provider|event|data.id|data.status|data.reference)` with a UNIQUE index.
- The response envelope's `status: true` does **not** mean the charge worked. Only
  `data.status` does. A too-short phone number and a declined payment both return
  `status: true`.

Hosted checkout (`initialize`) is kept as a fallback for card payers and for when the MoMo
push channel is having a bad day.

### SMS: **Arkesel** (confirmed)

`POST https://sms.arkesel.com/api/v2/sms/send`, header `api-key`, body
`{sender, message, recipients[], callback_url?}`. Registered sender ID `WAVLY` (≤ 11 chars).

Two things worth knowing that shaped the schema:

- **Delivery reports arrive in batches, late, at an unauthenticated callback URL.** So the
  handler must resolve `sms_id` against `messages.provider_message_id` and ignore anything
  it does not recognise. It must never trust a status for a message it did not send.
- **`GH¢` is not in the GSM-7 character set** and forces the message into UCS-2, which
  halves the per-segment length from 160 to 70 characters. All customer templates use
  `GHS`. That single choice roughly halves SMS cost — at ~20,000 messages/month across 100
  subscribers (OTP, receipts, two reminders each) it is real money.

### Auth: **phone + OTP** for customers, **email + password + TOTP** for admins

Customers get no password at all. A password on a shared family phone in a low-literacy
market is a support burden and a churn source; the phone number is already the account key
and the payment instrument. OTP is hashed with a server-side pepper and rate-limited on three
axes (per phone, per IP, per attempt count).

Admins get argon2id passwords and mandatory TOTP 2FA (RFC 6238) with hashed recovery codes,
because an admin account can issue refunds — a compromised one is a direct financial loss.
SMS-based 2FA for admins is explicitly **not** offered: SIM-swap is common in Ghana and a
GH¢7,000/month till is worth attacking.

### Edge node OS: **Debian 12 minimal**, everything under systemd

Chosen for boringness. FreeRADIUS, PostgreSQL and Node are all in the Debian repos, `systemd`
restarts `syncd` on crash, and there is no container runtime to maintain on a device that may
be managed by someone who has never seen a shell. Docker is fine if you prefer it; nothing in
the design depends on it.

---

## 1.10 Security architecture (summary; full detail in Phase 8)

- **HTTPS everywhere.** Cloudflare in front of Vercel with strict TLS and HSTS. The
  router-side activation page is HTTP *by necessity* (mixed content) and carries a one-time
  60-second MAC-bound token instead of credentials.
- **Never trust the client.** Prices, plan terms, amounts and expiry are read from the
  database on the server at request time. The client sends a plan code and an idempotency
  key, nothing else. `orders_total_ck` makes a tampered total a constraint violation.
- **Verify, then re-verify.** Signature check → persist → `GET /transaction/verify` →
  compare amount and currency → only then fulfil.
- **CSRF** via double-submit cookie on every state-changing route (`security.csrf_double_submit`).
- **Rate limiting** on OTP issue, OTP verify, voucher redeem, login, checkout and webhook —
  per IP *and* per phone, backed by Postgres so it survives a serverless cold start.
- **Secrets** in environment variables (Vercel + edge node), never in the database.
  `settings.is_secret` values are sealed with libsodium `secretbox`. The RADIUS shared secret
  exists only on the edge node and the router; `nas_devices.shared_secret_ref` is a pointer.
- **Least privilege.** The app connects to Supabase as a dedicated role with no `DELETE`
  grant on `audit_log`, and RLS denies `anon` and `authenticated` entirely — the portal is
  server-rendered and reaches data only through server-side code.
- **Data Protection Act 2012 (Act 843).** Minimal collection (phone, optional first name,
  usage, payment records — no ID document, no address, no date of birth), a versioned privacy
  notice with `users.privacy_notice_id` recording exactly which version was accepted, separate
  revocable marketing consent, an erasure path that retains only legally required financial
  rows, and `legal.data_protection_registration` to record your Data Protection Commission
  registration number. **Registering as a data controller with the DPC is a legal obligation,
  not a nice-to-have — budget for it.**
- **Audit.** Every money-touching write is in `audit_log` with actor, before/after, IP and a
  mandatory `reason`. Kept seven years.

---

## 1.11 Scale path

The design changes at each step, not just the instance size.

| Stage | Users | What changes |
|---|---|---|
| **Now** | < 100, 1 site | Everything as documented. Supabase Pro (or Free with a caveat), Vercel Hobby→Pro, one GH¢1,200 mini PC, one MikroTik. |
| **500** | 1 site, more APs | Add APs (all authenticate to the same edge FreeRADIUS). Move `usage_records` to monthly RANGE partitioning — the `(id, created_at)` composite PK on `audit_log` and the BRIN indexes were chosen so this is mechanical. Add a read replica for the dashboard if reporting gets slow. Promote Vercel to a dedicated instance for the cron worker. |
| **2,000** | 2–5 sites | One edge node per site (the schema is already `site_id`-scoped end to end). `syncd` becomes multi-tenant by `node_id`. Move the job queue to a dedicated worker process. Add a second RADIUS server per site for HA. Consider MikroTik CHR + CAPsMAN for central AP management. |
| **10,000+** | many sites | Replace Postgres-as-queue with a real broker. Shard accounting by site. The business tables stay where they are — they are small. |

Nothing in the schema needs to change to add a second village. That was the point of putting
`site_id` on `users`, `plans`, `orders`, `subscriptions`, `nas_devices`, `revenue_daily`,
`jobs`, `receipts` and `usage_daily` from day one, when there is exactly one site.

---

## 1.12 Bill of materials (rough, GH¢, November 2026 — verify locally)

| Item | One-off | Monthly | Notes |
|---|---|---|---|
| Starlink Mini + mount | ~5,500 | ~640–1,600 | **Confirm the data allowance.** Biggest single risk. |
| MikroTik hAP ax3 | ~1,900 | — | RouterOS v7, dual-band, gigabit. |
| Edge node (N100 mini PC, 16 GB, 512 GB SSD) | ~2,200 | — | A Raspberry Pi 4 works and is ~GH¢900; the mini PC is faster and more reliable on dirty power. |
| UPS for router + edge node (1000 VA) | ~900 | — | Non-negotiable. See §1.8. |
| Switch, cabling, enclosure, lightning protection | ~1,500 | — | Starlink and the antenna cable need surge protection. |
| Supabase Pro | — | ~120 ($25) | PITR backups, more connections. Free tier to start. |
| Vercel Pro | — | ~100 ($20) | Hobby is fine until you need cron reliability and log retention. |
| Domain + Cloudflare | ~150 | ~10 | `.com`. Cloudflare free tier for DNS/TLS/WAF. |
| Arkesel SMS credit | — | ~250–600 | ~20k messages/month. Prepaid. |
| Paystack | — | ~1.5 % + fixed | Netted in settlement, not a bill. |
| Data Protection Commission registration | ~300–800 | — | Legal requirement under Act 843. |
| **Total** | **~12,500** | **~2,100–3,000** | |

At 100 subscribers on a GH¢70/GH¢100 mix (~GH¢8,500/month gross, minus ~1.5 % Paystack fees
and SMS), the recurring margin is roughly GH¢5,000–6,000/month and the one-off cost is
recovered in about three months. The dominant variable is not software — it is whether your
Starlink plan tolerates the traffic.

---

## 1.13 Open risks, ranked

1. **Starlink data allowance vs. 100 users × 100 GB.** Business-ending if wrong. *Mitigation:
   confirm in writing; instrument `site bandwidth used` from day one; make caps real.*
2. **Power.** More outage minutes than the satellite. *Mitigation: UPS, and consider a small
   solar setup for the router + edge node later.*
3. **Paystack MoMo approval rates vary by network.** Telecel in particular returns `send_otp`
   and needs a `*110#` voucher flow that confuses customers. *Mitigation: show the operator's
   own `display_text` verbatim; keep vouchers as the fallback; measure success rate by network
   in `revenue_daily.by_network`.*
4. **Account sharing.** One GH¢70 plan serving a whole compound. *Mitigation:
   `max_simultaneous_devices` (FreeRADIUS `Simultaneous-Use`) plus optional MAC binding, both
   per plan and per user.*
5. **Voucher code guessing.** *Mitigation: 60-bit Crockford base32 codes with a check digit,
   local validation before any DB hit, 5 tries per code, 20 per IP per hour, every miss logged
   to `security_events`.*
6. **One-person operation.** Every manual step will eventually be skipped. *Mitigation: the
   `jobs` queue, the reconciliation jobs, and `backup_runs.restore_tested_at` exist to make the
   correct action automatic and the silent failure visible.*
7. **AirtelTigo provider code drift** (`atl` vs `tgo` in Paystack docs). *Mitigation: stored as
   a setting, correctable without a deploy.*

---

**Next: [02-database-schema.md](./02-database-schema.md)** — every table, field, relationship
and the reasoning behind the ones that look unusual.
