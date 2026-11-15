# 04 — FreeRADIUS on the edge node

Phase 3. What runs on the box in Nkawie, why it is shaped this way, and the
specific ways it can fail silently.

The edge node is a Debian 12 mini PC at `192.168.88.10`. Debian 12 ships
**FreeRADIUS 3.2.x**, so everything here is 3.x unlang. Version 4.x is configured
completely differently (`recv`/`send` instead of `authorize`/`authenticate`, a
`radius.coa` module instance instead of `update coa`) — **do not copy 4.x syntax
into these files**, and if the node is ever upgraded to 4.x this configuration
must be rewritten, not patched.

Everything in `deploy/edge/freeradius/` is a **template**. Run
`npm run edge:generate` on the node to produce real config from those templates
plus `/etc/wavly/edge.env` (`EDGE_DATABASE_URL`, `RADIUS_BIND_ADDRESS`,
`EDGE_LOCAL_ADMIN_PASSWORD`, and one `RADIUS_SECRET_*` per router, named by
`nas_devices.shared_secret_ref`).

`.env.example` is the contract for those names, and a test asserts both that every
variable the generator requires is documented there and that the secret variable
name matches what the seed points at. Those two had drifted apart — the example
file documented `RADIUS_SECRET_NKAWIE_HAP_AX3` while the seed said
`RADIUS_SECRET_NKAWIE01` — which would have made a node provisioned exactly as
documented fail to render. The rendered output goes to `deploy/edge/local/`,
which is gitignored, because it contains the edge database password and the RADIUS
shared secret.

---

## 4.1 What this phase produced

| Path | What it is |
|---|---|
| `deploy/edge/generate.mjs` | Renders the templates, substitutes secrets from the environment, runs static cross-checks |
| `deploy/edge/freeradius/sites-available/wavly` | The virtual server. Replaces `default` |
| `deploy/edge/freeradius/sites-available/originate-coa.tmpl` | One CoA `home_server` per router — the destination `update coa` needs |
| `deploy/edge/freeradius/clients.conf.tmpl` | Which routers may talk to us, and their secrets |
| `deploy/edge/freeradius/policy.d/wavly` | MAC normalisation, device roster, expiry, fair usage |
| `deploy/edge/freeradius/mods-available/sql` | PostgreSQL connection (templated; holds the password) |
| `deploy/edge/freeradius/mods-available/wavly` | `linelog` canary + accounting `detail` file |
| `deploy/edge/freeradius/mods-config/sql/main/postgresql/queries.conf` | Upstream v3.2.x copy with exactly one deviation |
| `deploy/edge/freeradius/mods-config/files/authorize` | The local operator account that works without the database |
| `deploy/edge/freeradius/dictionary.wavly` | Our private attributes |
| `deploy/edge/bin/wv-coa` | Sends CoA / Disconnect on demand, for `syncd` and for humans |
| `deploy/edge/systemd/freeradius.service.d/override.conf` | Boot ordering, restart, hardening |
| `db/migrations/0003_edge_radius_logic.sql` | The SQL the policies call |
| `deploy/edge/tests/edge-config.test.mjs` | 45 tests |

`docs/07-deployment.md` (Phase 7) will carry the provisioning script. Until then
the rendered `README.txt` in the output directory is the install runbook.

---

## 4.2 A new virtual server, not an edited `default`

The stock `sites-available/default` is about 1300 lines and loads EAP, LDAP,
Perl, Python, `unix` passwords and digest authentication. We ship
`sites-available/wavly` instead and **delete `sites-enabled/default`**.

Two reasons, and only one of them is tidiness:

1. **Attack surface.** This machine sits on a LAN full of people with a financial
   incentive to get free internet. `unix` authentication would mean any shell
   account on the edge node is also a Wi-Fi credential. EAP would mean an open TLS
   handshake endpoint that nothing uses. Neither is a hypothetical; both are
   modules that are enabled by default in a stock install.
2. **Leaving `default` enabled means two servers listen on 1812/1813.** Whichever
   binds first wins, and the failure looks like "our policies are being ignored".

Deleting it is in the install notes and a test asserts the rendered site does not
enable `eap`, `ldap`, `unix` or `digest`.

The listeners are bound to `192.168.88.10`, not `*`. Harmless today, but if this
box ever gets a second interface, `*` would expose an authentication service to
every customer on the hotspot network.

---

## 4.3 `nasreload`: the missing table that would have broken every login

**This is the most consequential finding of the phase.**

The official FreeRADIUS PostgreSQL schema is nine tables. Phase 1 reproduced eight
of them. The missing one was `nasreload`:

```sql
create table if not exists nasreload (
  nasipaddress inet primary key,
  reloadtime   timestamptz not null
);
```

It is easy to look at that table and think it is optional bookkeeping. It is not.
Both `simul_count_query` and `simul_verify_query` in the stock `queries.conf`
contain `LEFT JOIN nasreload ON ...`, and those are the two queries the `session`
section runs to enforce `Simultaneous-Use`.

Every plan we sell sets `Simultaneous-Use` (it comes from
`max_simultaneous_devices`). So the moment the `session` section was enabled on a
real database, **every single Access-Request would have raised a SQL error** —
"relation nasreload does not exist" — and nobody would be able to log in. Not
some users. All of them.

It would also have been discovered on site, in front of customers, on opening day,
because nothing in the sandbox can catch a missing relation: there is no live
PostgreSQL here. What caught it was downloading the official `schema.sql` from the
v3.2.x tag and diffing tables, columns and indexes against `0002` — see 4.13.

`radpostauth` was also incomplete (missing `calledstationid`, `callingstationid`,
`class`), and two `radacct` indexes were absent. Both fixed.

**What was deliberately *not* added:** `radacct_whoson` and the `*_UserName_lower`
indexes. A naive read of `schema.sql` finds them, because they are present in the
file — inside comments. `radacct_whoson` is a UNIQUE index on
`(username, acctstarttime, nasipaddress)`; adding it would reject the accounting
INSERT whenever two customers start a session in the same second on the same
router. That silently loses usage records, i.e. revenue, and it only happens under
load — exactly when you are least able to investigate.

---

## 4.4 The check/reply table split *is* the interface with `syncd`

`syncd` (Phase 4) writes control attributes into the local database. FreeRADIUS
reads them. The table each attribute goes into is not a style choice — `rlm_sql`
puts `radcheck`/`radgroupcheck` items into `&control:` and
`radreply`/`radgroupreply` items into `&reply:`.

Get it wrong and the failure is invisible. Write the data cap to `radgroupreply`
and it lands in `&reply:`, which means two things happen at once: the cap is **sent
to the router** (which ignores an attribute it does not know), and the fair-usage
policy reads an **empty** control attribute and never fires. Every log says the
customer is within their allowance.

The full contract is the table at the top of `policy.d/wavly`. It is the interface
definition between two components written in different phases, and changing it is
a breaking change on both sides.

Two naming rules carried over from the schema design, because they are what make
the system operable:

- **Groups are named after the rate profile, not the plan** (`rate-12000-6000`,
  `fup-rate-4000-2000`, `suspended`). Changing the speed 80 customers get is then
  one `UPDATE` plus 80 CoA packets, not 80 row rewrites.
- **FUP is a group at `radusergroup.priority` 10**, above the plan group at
  priority 1. `group_membership_query` orders by priority ascending and later `:=`
  reply items win, so the FUP rate overrides the plan's. Clearing FUP is a single
  `DELETE` that can never remove the purchased entitlement.

---

## 4.5 Logic in SQL, not in unlang

The device roster decision is one function call:

```sql
select wavly_check_device(username, mac, max_devices, binding_required, nas_ip);
```

returning one of `allow`, `allow_new`, `reject_blocked`, `reject_bound`,
`reject_limit`.

The alternative is writing the same logic in unlang, which means string surgery on
MAC addresses, `%{sql: ...}` calls embedded in `if` conditions, and comparisons
between values that are all text. It would work. It would also be the piece of the
system nobody dares touch in six months, and the piece that decides whether a
paying customer can log in.

Three properties of the function are deliberate:

- **One round trip.** Authorization is on the hot path for every login, with a
  ~3 s router timeout. The function does `SELECT ... FOR UPDATE`, checks the
  roster and returns; the policy does not then make three more queries.
- **It registers unseen devices as `status='pending'` even when it rejects.** A
  silently refused device with no row in `edge_devices` is indistinguishable from a
  broken router. With a row, the customer sees "new device waiting for approval" in
  the portal and can self-approve it.
- **No MAC sent → `allow`.** Never block a customer because an attribute is
  missing. If a firmware upgrade stops MikroTik sending `Calling-Station-Id`,
  device binding degrades to cloud-enforced `Simultaneous-Use` and a canary log
  file (`wavly-mac-missing.log`) fills up. It does not take the site down.

`wavly_queue(kind, payload)` is the single entry point into `sync_outbox`, and it
catches constraint violations, raises a warning and returns `NULL` — so a
bookkeeping failure can never stop a customer authenticating.

---

## 4.6 CoA can only be originated in response to a packet

This constraint shapes the whole expiry design, so it is worth stating plainly.

In FreeRADIUS 3.x, `update coa { ... }` and `update disconnect { ... }` may appear
in any request-processing section **except** `pre-proxy` and `post-proxy`, and they
cannot be sent at all if the original request was proxied. There is no timer, no
cron hook, no "send this at 23:59".

So the fair-usage case is easy: an interim Accounting-Request arrives every five
minutes, we compare the counter, and we attach a CoA to that request. Local, fast,
no WAN involved.

The **expiry** case has no such packet. A monthly subscription ends at a wall-clock
time and the router sends us nothing at that moment. Without an out-of-band
disconnect, expiry only takes effect at the customer's *next* re-authentication —
which for a monthly plan could be days later. They keep using a service they have
stopped paying for, and the customer who pays for it is the one being squeezed by
the site queue.

Hence `deploy/edge/bin/wv-coa`: `syncd` shells out to it, and so can an operator.

```
wv-coa disconnect --nas 192.168.89.1 --user 0244123456
wv-coa throttle   --nas 192.168.89.1 --user 0244123456 --rate '2M/4M'
```

Three details that are easy to get wrong and all fail silently:

- **A Disconnect-Request must carry no authorization attributes** (RFC 5176) or the
  NAS replies `Disconnect-NAK` with `Unsupported-Attribute`. So `disconnect` sends
  only session identification; `throttle` is the one that carries
  `Mikrotik-Rate-Limit`. A test asserts the disconnect packet contains no rate
  limit.
- **Exit codes distinguish NAK (2) from no-reply (3).** A NAK means the router is
  fine and our attributes are wrong — retrying is pointless. A timeout means the
  CoA path is broken (firewall, or `/radius incoming` is not `accept=yes`) —
  retrying is the only thing that helps. Collapsing them into one failure code
  means `syncd` cannot choose correctly.
- **An unrecognised reply is never reported as success.** Claiming a disconnect
  worked when it did not is how a customer stays online for free for a month.

MAC arguments are normalised to upper-case colon-separated before sending, because
RouterOS is configured with `radius-mac-format=XX:XX:XX:XX:XX:XX` and a hyphenated
or lower-case MAC matches no session.

`home_server` definitions live in `sites-available/originate-coa`, which is where
upstream puts them, and each client points at **its own** via `coa_server`. Not a
shared `home_server_pool`: a pool of `type = fail-over` sends to the first *alive*
member, which with two routers is the wrong one half the time — and the CoA still
gets ACKed, so it looks like it worked.

---

## 4.7 Blast-RADIUS is a two-sided problem

CVE-2024-3596 showed that RADIUS/MD5 responses can be forged by an on-path
attacker using a chosen-prefix MD5 collision. The mitigation is
`Message-Authenticator` on every packet, in both directions. Both directions matter
here, and they fail differently.

**Inbound (router → us).** `clients.conf` sets
`require_message_authenticator = yes`. RouterOS 7.x does send it, so this costs
nothing and stops anyone who reaches UDP 1812 from forging a login. If it ever
breaks every login, the FreeRADIUS log says
`BlastRADIUS check: Received packet without Message-Authenticator` — and the fix is
to upgrade that router's firmware, **not** to set the flag to `no`.

**Outbound (us → router).** This is the one that bites. RouterOS **silently drops**
an Access-Accept or Access-Reject that lacks a Message-Authenticator. Its log says:

```
radius,debug  received packet for ... with missing message auth, dropping
hotspot,info  login failed: RADIUS server is not responding
```

while FreeRADIUS logs `Login OK: [customer]` and looks completely healthy. Our side
reports success, the router reports a timeout, every login on the site fails, and
the two logs contradict each other. That combination is the single most confusing
failure in this stack.

So `post-auth` sets it explicitly, before the `Post-Auth-Type` branches so rejects
get it too:

```
if (!&reply:Message-Authenticator) {
	update reply {
		&Message-Authenticator := 0x00
	}
}
```

The server fills in the real HMAC just before the packet goes on the wire.
FreeRADIUS ≥ 3.2.5 does this automatically as its own Blast-RADIUS mitigation, and
Debian may ship either side of that line — setting it explicitly removes the
dependency on which point release is installed. The guard means we never emit two.

`radiusd.conf` is package-managed and not rendered here, so the install notes say
to add `require_message_authenticator = auto` and `limit_proxy_state = auto` to its
`security { }` section by hand.

---

## 4.8 Passwords: what gets written to disk, and where

`queries.conf` is a verbatim copy of the upstream v3.2.x file with **exactly one
deviation**, marked `WAVLY OVERRIDE`. The whole file had to be copied because
FreeRADIUS does not merge two config sections with the same name — a second
`post-auth { ... }` included after the stock one is a parse error or is silently
ignored, not an override.

The deviation is the post-auth INSERT. Upstream writes:

```
'%{%{User-Password}:-%{Chap-Password}}'
```

That is every customer's Wi-Fi password, in cleartext, in a table on a machine in
a village, copied into every nightly backup that goes off-site. We write the
literal `'REDACTED'` instead. The column stays non-null and greppable, so
`radpostauth` still answers the question it is actually for — *who was refused,
when, and why*.

We also add `NULLIF('%{Called-Station-Id}','')` and `NULLIF('%{Calling-Station-Id}','')`,
which the stock query drops. Those are what make a failed-auth row actionable:
without the caller's MAC you can see that logins are failing but not from which
device, which is exactly what you need to distinguish credential stuffing from one
customer sharing their code with four neighbours.

A test asserts the rendered query contains `'REDACTED'` and does not contain
`User-Password`.

**Do not "simplify" the accounting queries.** They compute
`('%{...Acct-Input-Gigawords}:-0}'::bigint << 32) + Acct-Input-Octets::bigint`.
That shift is load-bearing: a 32-bit octet counter wraps at 4 GiB, which is about
35 minutes at 20 Mbps. Drop the shift and every heavy user's session is truncated
at 4 GiB — they download 200 GB, we bill 4 GB, and the numbers look plausible
enough that nobody notices for a month.

---

## 4.9 The shared secret lives in a file, not the database

`mods-available/sql` sets **`read_clients = no`**.

With it on, FreeRADIUS reads clients from the `nas` table, which means the RADIUS
shared secret sits in a column — and therefore in every `pg_dump`, including the
nightly copy that leaves the site. That dump would then contain the one credential
that lets anyone on the LAN authenticate any user they like, or forge an
Access-Accept. Turning it off costs one thing: adding a router means regenerating
`clients.conf` and reloading FreeRADIUS.

That friction is accepted, and deliberate. Adding a RADIUS client is a change that
ought to involve a human.

The `nas` table still exists and is still populated, for inventory, the heartbeat
(`last_acct_at`) and as the list of CoA targets. Its `secret` column stays empty.
Install step 6c is a `psql` query that checks it, because a real value appearing
there later is how this decision gets quietly undone.

Secrets reach the config through `nas_devices.shared_secret_ref`, which is a
**pointer** like `edge:env:RADIUS_SECRET_NKAWIE01` — the name of an environment
variable, never a value. The generator resolves it at render time and refuses to
run if the column holds a literal, with an error explaining the required format.

Note we deliberately do **not** follow upstream's advice that the CoA secret
"SHOULD NOT be the same as" the client secret. RouterOS has exactly one secret per
RADIUS client entry and `/radius incoming` authenticates CoA with it, so on
MikroTik the two must match or every CoA is rejected.

A secret shorter than 22 characters is a **fatal** error, not a warning: it can be
recovered offline from a single captured packet.

---

## 4.10 Fair usage locally; the leak we accept

The FUP check runs in the `accounting` section on interim updates, comparing
`Wavly-Used-Baseline + Acct-Input-Octets + Acct-Output-Octets` against
`Wavly-Data-Cap`, and issuing `update coa` with the FUP rate limit.

Doing this locally rather than in the cloud is the point. The cloud path is
*usage uploads → cloud computes → pushes group membership → syncd applies → CoA*,
with a satellite link in the middle. Every hop can be delayed by an outage, and
the customer keeps downloading at full speed meanwhile. The local path is one host
and one comparison, and works with Starlink down — which is the entire continuity
story of this deployment.

**Known and accepted leak:** if a customer reconnects before `syncd` has refreshed
the baseline, they get at most one extra session's worth of data. That is bounded,
and the alternative — refusing logins while the WAN is down — is far worse for a
business whose promise is that it still works when Starlink does not.

Two other properties:

- **FUP throttles, it never disconnects.** Running out of included data at 2am
  should slow someone down, not cut them off; they have paid for the remaining days
  on the plan. A test asserts `update disconnect` does not appear in the FUP policy.
- **It fires once.** Without the `Wavly-Fup-Active` guard, every interim update
  re-sends the same CoA, churning the router's queue tree and filling its log with
  a message that says nothing new.

Byte counters are `integer64` in the dictionary. A 250 GB cap is 268435456000,
which overflows a 32-bit RADIUS attribute (max ~4 GiB) and **wraps silently** to a
small number — turning a cap into a much smaller cap, or into nothing.

---

## 4.11 The account that works when the database does not

`mods-config/files/authorize` defines one local account, and the `files` module
runs **before** `sql` in the site.

If edge Postgres is down — restarting, disk full, a migration half-applied — then
`sql` returns `noop`, there is no `Cleartext-Password` to check, and every login is
rejected. Customers survive that. But the operator trying to fix the database
cannot get online to read a runbook, reach Supabase, or download a package. On a
site whose only internet path is this RADIUS server, that turns a bad hour into a
bad day.

Constraints on it, all enforced by tests:

- The password is substituted from `$EDGE_LOCAL_ADMIN_PASSWORD`. A real one never
  appears in git.
- It has an `Expiration` (default 90 days). An emergency account that never expires
  is a standing backdoor.
- `Simultaneous-Use = 2` — a laptop and a phone, not a village.
- Its rate limit is rendered from a real seeded rate profile via
  `$EDGE_LOCAL_ADMIN_RATE_PROFILE`, so an operator can run a meaningful speed test.
- A commented-out `DEFAULT` catch-all is present and **must stay commented**: an
  entry that accepts any username makes it impossible to tell whether a customer's
  problem is authentication or something else, which is the first question you need
  answered.

**Customer accounts must never go here.** Every customer credential comes from the
database via `syncd`, so the cloud stays authoritative and a suspension actually
takes effect. A customer defined in `files` could not be suspended, would not be
billed, and would not appear in any usage report — and you would find out when they
complained.

---

## 4.12 What the generator refuses to do

| Refusal | Why |
|---|---|
| Leave any `@@TOKEN@@` unsubstituted | `password = "<token>"` is a valid FreeRADIUS string. The server starts, cannot reach the database, and gives no obvious cause |
| Print secrets to stdout without `--allow-secrets-on-stdout` | Terminal scrollback, CI logs and shell history are how secrets reach git later |
| Render when a required env var is missing | The error names the variable |
| Accept a literal secret in `shared_secret_ref` | That value would travel into every off-site backup |
| Accept a RADIUS secret under 22 characters | Recoverable offline from one captured packet |
| Emit a `coa_server` with no matching `home_server` | FreeRADIUS logs `Unknown destination for CoA request` and drops it — throttling looks like it worked while the customer keeps full speed |
| Call a policy that is not defined | FreeRADIUS refuses to start |
| Write output anywhere git can see it | The output dir writes its own `.gitignore` on the first run, and the root `.gitignore` covers `deploy/edge/local/` for the first run and any custom `--out` |

The static checks run on every render, so a template edit that breaks one of these
invariants fails before anything reaches the node. `--check` additionally runs
`freeradius -XC` against the output when the binary is available.

---

## 4.13 Corrections this phase made to earlier phases

| # | Was | Now | Why |
|---|---|---|---|
| 1 | `0002` had 15 edge tables | **16** — `nasreload` added | Both `simul_*` queries `LEFT JOIN` it; enabling `session { sql }` would raise a SQL error on **every** Access-Request (4.3) |
| 2 | `radpostauth` had 5 columns | 8 — `calledstationid`, `callingstationid`, `class` | Matches upstream; the MAC columns are what make a failed-auth row actionable (4.8) |
| 3 | Two `radacct` indexes absent | `radacct_active_user_idx`, `radacct_stop_user_idx` added | Upstream defines them; the simul queries scan exactly those shapes |
| 4 | `check-schema.mjs` listed three SQL files | Discovers `db/migrations` + `db/seed` | Adding `0003` made the checker **silently skip it** while still printing "No structural errors found" |
| 5 | `checker.test.mjs` listed the same three files | Discovers them, plus a test asserting `0003` is in scope | Same bug in the tests: the suite passed while the new migration went unexamined |
| 6 | `gen-schema-doc.mjs` listed two files, with hand-written counts ("42 tables", "15 tables") | Discovers migrations, classifies cloud vs edge, computes counts | `docs/schema-reference.md` was omitting `0003` entirely and its prose counts were already stale |
| 7 | `seed.mjs` returned `[]` for `INSERT ... SELECT` | Resolves it via the source table's natural key | The `nas_devices` row uses that form, so `loadSeed()` reported "no NAS devices" for a seed that plainly had one |
| 8 | `.env.example` said `RADIUS_SECRET_NKAWIE_HAP_AX3`; the seed's `shared_secret_ref` said `RADIUS_SECRET_NKAWIE01` | Aligned, and a test now compares the two | A node provisioned exactly as documented would have failed to render |
| 9 | `sites-available/wavly` hardcoded ports 1812/1813; the generator wanted `EDGE_DB_*` while `.env.example` documented `EDGE_DATABASE_URL` | Ports tokenised; `EDGE_DATABASE_URL` decomposed, discrete vars as fallback | The same password written twice in one file will eventually be rotated once |

Items 4–7 are the same failure mode four times over: a hardcoded list of files, or
a silently-skipped statement shape, that produces a **successful run** covering less
than it claims. A tool that reports success while examining nothing is worse than no
tool, because it supplies the confidence the tool exists to earn. Each is now
covered by a test that fails if the coverage shrinks again.

Also from this phase, found by reviewing generated output rather than by reasoning:

- `home_server` blocks were being emitted into `clients.conf`. Upstream puts them in
  `sites-available/originate-coa`; they are now generated there.
- `bin/wv-coa --help` printed "--nas is required", because `--help` was consumed as
  the action positional.
- `basename` in `wv-coa` broke the script under a stripped `PATH`; replaced with
  `${0##*/}`.

---

## 4.14 What must be verified on the node

Static checks cannot prove a RADIUS server works. On the node, in order:

1. `freeradius -XC` — fix **everything** it reports before starting. A server that
   half-parses rejects every login and logs something unrelated.
2. `radtest <user> <pass> 192.168.88.10 0 <secret>` — then check the **router's**
   log, not just ours. If `radtest` says Access-Accept but the router says
   `missing message auth, dropping`, see 4.7.
3. `bin/wv-coa disconnect --nas 192.168.89.1 --user <user>` — exit 0 is an ACK;
   2 is a NAK (our attributes are wrong); 3 is no reply (firewall, or
   `/radius incoming` is not `accept=yes`).
4. `wc -l /var/log/freeradius/wavly-mac-missing.log` — non-zero on a site that was
   working yesterday means the router stopped sending `Calling-Station-Id`, and
   device binding has silently stopped working.
5. `psql -U postgres -d wavly_edge -c 'select nasname, secret from nas'` — the
   secret column must be empty or a placeholder.
6. Kill Postgres, confirm the local operator account (4.11) still authenticates,
   confirm customers are refused with a sane message, then start it again and
   confirm `detail` files can be replayed.

---

## 4.15 Placeholder that must be replaced before go-live

`dictionary.wavly` declares `VENDOR Wavly 52381`. That private enterprise number
is a **placeholder** — it is not assigned to anyone by IANA, and using an
unassigned number risks colliding with a vendor who has it.

Today it is harmless, because every Wavly attribute is control-only and none of
them ever goes on the wire. That changes the moment any of them is put in an
Access-Accept. Before Phase 6 go-live, either register a PEN with IANA (free,
takes days) or delete the vendor block and use standard/`Tmp-*` attributes
instead.
