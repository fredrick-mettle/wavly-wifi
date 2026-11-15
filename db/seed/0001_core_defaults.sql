-- ============================================================================
--  Wavly WiFi — seed data: the business defaults for a Nkawie hotspot
-- ----------------------------------------------------------------------------
--  Idempotent: safe to run repeatedly (ON CONFLICT DO UPDATE). Every value here
--  is also editable from the admin dashboard afterwards; this file only defines
--  the starting position so the system is useful the moment it boots.
--
--  Run AFTER 0001_initial_cloud.sql:
--    psql "$SUPABASE_DB_URL" -f db/seed/0001_core_defaults.sql
--
--  NO ADMIN USER IS CREATED HERE. A seed file that contains a password is a
--  password in git. Use: node scripts/create-admin.mjs --email you@x --role owner
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Site
-- ---------------------------------------------------------------------------
insert into sites (code, name, town, region, country, timezone, latitude, longitude,
                   support_phone_e164, support_hours, is_active, notes)
values ('nkawie-01', 'Nkawie Main', 'Nkawie', 'Ashanti', 'GH', 'Africa/Accra',
        6.749000, -1.620000, '+233244000000', 'Mon-Sat 7am-9pm, Sun 9am-6pm', true,
        'First site. Starlink Mini backhaul, MikroTik hAP ax3 hotspot, one edge node.')
on conflict (code) do update set
  name = excluded.name, town = excluded.town, region = excluded.region,
  latitude = excluded.latitude, longitude = excluded.longitude,
  support_hours = excluded.support_hours, updated_at = now();


-- ---------------------------------------------------------------------------
-- Privacy notice (Ghana Data Protection Act 2012, Act 843)
-- ---------------------------------------------------------------------------
insert into privacy_notices (version, locale, title, body_markdown, published_at)
values (1, 'en-GH', 'Wavly WiFi Privacy Notice', $md$
# What we collect, and why

Wavly WiFi provides internet access in Nkawie. We collect the smallest amount of
information that lets us connect you and bill you correctly.

## What we collect

* **Your mobile phone number.** This is your account name and the number your
  Mobile Money payment comes from. We cannot provide the service without it.
* **Your payment records.** Amount, date, plan, and the Mobile Money network you
  used. We keep these so we can issue receipts and resolve disputes.
* **Your usage.** How much data you used and when you were connected, plus the
  device MAC addresses you connect from. We use this to enforce your plan, to
  stop one account being shared beyond its limit, and to answer "where did my
  data go?".
* **Your first name**, if you choose to give it. It is optional.

## What we do NOT collect

We do not ask for your Ghana Card, your home address, your date of birth, or any
photo. We do not read, store, or inspect the content of what you browse — we
record only the amount of data, not the pages. We do not sell your data to
anyone, ever.

## Who sees your data

* **Paystack** processes your payment and receives your phone number and the
  amount. They are a licensed payment provider.
* **Arkesel** sends the SMS messages you receive from us and receives your phone
  number and the message text.
* **Starlink** carries your internet traffic, like any internet service provider.

We do not share your data with any other third party except where Ghanaian law
requires it.

## How long we keep it

Your account and payment records are kept while you are a customer and for seven
years afterwards, because tax and commercial law requires it. Raw per-session
usage detail is deleted after 13 months, keeping only daily totals. Failed login
records are deleted after 90 days.

## Your rights

Under the Data Protection Act 2012 (Act 843) you may ask us what we hold about
you, ask us to correct it, or ask us to delete your account. Deletion keeps only
the financial records the law requires us to retain. To exercise any of these
rights, contact us on the support number below or speak to the operator at the
shop.

## Your consent is separate from your service

We will only send you marketing messages if you tick the box asking for them. You
can withdraw that at any time and it will never affect your internet.

_Last updated: 15 November 2026. Version 1._
$md$, now())
on conflict (version) do update set
  title = excluded.title, body_markdown = excluded.body_markdown,
  published_at = now(), updated_at = now();


-- ---------------------------------------------------------------------------
-- Runtime settings — everything an admin can change without a deploy
-- ---------------------------------------------------------------------------
insert into settings (key, value, value_type, category, description, is_secret, is_public) values
  -- Branding
  ('branding.business_name',            '"Wavly WiFi"',                  'string', 'branding',   'Shown on the portal, receipts and SMS.', false, true),
  ('branding.portal_url',               '"https://portal.wavlywifi.com"','string', 'branding',   'Public portal base URL. Must match the MikroTik hotspot DNS name.', false, true),
  ('branding.admin_url',                '"https://admin.wavlywifi.com"', 'string', 'branding',   'Admin dashboard URL. Should be a separate hostname so it can be firewalled.', false, false),
  ('branding.hotspot_dns_name',         '"portal.wavlywifi.com"',        'string', 'branding',   'The DNS name the captive portal answers on. Clients are redirected here.', false, true),
  ('branding.wifi_ssid',                '"Wavly WiFi"',                  'string', 'branding',   'SSID advertised by the AP.', false, true),
  ('branding.support_phone_e164',       '"+233244000000"',               'string', 'branding',   'Support number printed in SMS and on the portal.', false, true),
  ('branding.timezone',                 '"Africa/Accra"',                'string', 'branding',   'All customer-facing times render in this zone. Ghana has no DST.', false, true),
  ('branding.logo_path',                '"/assets/logo.svg"',            'string', 'branding',   'Local asset path. Never a CDN — the portal must render when the internet is down.', false, true),

  -- Payments (Paystack)
  ('payments.provider',                 '"paystack"',                    'string', 'payments',   'Active collection provider.', false, false),
  ('payments.currency',                 '"GHS"',                         'string', 'payments',   'Only GHS is supported by Paystack mobile money in Ghana.', false, false),
  ('payments.momo_provider_codes',      '{"mtn":"mtn","telecel":"vod","airteltigo":"atl"}', 'json', 'payments',
     'Maps our network names to the Paystack `mobile_money.provider` code. Paystack documentation has disagreed over time (atl vs tgo for AirtelTigo), so this is data, not code. Verify with GET /bank?country=ghana&type=mobile_money and update here without a deploy.', false, false),
  ('payments.momo_prefix_map',          '{"mtn":["24","25","53","54","55","59"],"telecel":["20","50"],"airteltigo":["26","27","56","57"]}', 'json', 'payments',
     'Two-digit prefixes after +233 used to pre-select the network on the checkout form. Number portability means this is a hint; the customer can always override it.', false, true),
  ('payments.fallback_email_domain',    '"portal.wavlywifi.com"',        'string', 'payments',   'Paystack requires an email. We synthesise <phone_local>@<domain> rather than asking the customer for one they may not have. Never used to send mail.', false, false),
  ('payments.order_ttl_minutes',        '15',                            'number', 'payments',   'Minutes before a pending_payment order is marked expired.', false, false),
  ('payments.momo_approval_window_seconds', '180',                       'number', 'payments',   'Paystack gives the customer 180s to approve the MoMo prompt. Drives the on-screen countdown.', false, false),
  ('payments.verify_poll_interval_seconds', '10',                        'number', 'payments',   'How often the browser re-checks a pending payment. Paystack asks you to wait >=10s before check_pending.', false, false),
  ('payments.verify_max_polls',         '18',                            'number', 'payments',   '18 x 10s = 3 minutes, matching the approval window plus margin.', false, false),
  ('payments.amount_mismatch_action',   '"hold_and_alert"',              'string', 'payments',   'What to do if a webhook amount differs from the order: hold_and_alert (safe default) or accept_and_log.', false, false),
  ('payments.min_charge_pesewas',       '100',                           'number', 'payments',   'Reject orders below GH¢1 — MoMo fees make them uneconomic.', false, false),

  -- SMS (Arkesel)
  ('sms.provider',                      '"arkesel"',                     'string', 'sms',        'Active SMS provider.', false, false),
  ('sms.sender_id',                     '"WAVLY"',                       'string', 'sms',        'Arkesel registered sender ID. Max 11 characters. Must be registered in the Arkesel dashboard or sends are rejected.', false, false),
  ('sms.otp_length',                    '6',                             'number', 'sms',        'Digits in a one-time code.', false, false),
  ('sms.otp_ttl_minutes',               '5',                             'number', 'sms',        'How long an OTP stays valid.', false, false),
  ('sms.otp_max_attempts',              '5',                             'number', 'sms',        'Wrong tries before the challenge dies.', false, false),
  ('sms.otp_resend_cooldown_seconds',   '60',                            'number', 'sms',        'Minimum gap between OTP sends to one number.', false, false),
  ('sms.otp_max_per_phone_per_hour',    '3',                             'number', 'sms',        'Hard cap per number. OTP SMS costs money, so this also protects the Arkesel balance.', false, false),
  ('sms.otp_max_per_ip_per_hour',       '10',                            'number', 'sms',        'Hard cap per IP.', false, false),
  ('sms.marketing_window',              '{"start_hour":8,"end_hour":19,"blocked_weekdays":[0]}', 'json', 'sms',
     'Ghana promotional sending window: 08:00-19:00, not Sundays. Applies only to category=marketing; OTP, receipts and expiry reminders are transactional and may go any time.', false, false),
  ('sms.daily_spend_cap_pesewas',       '50000',                         'number', 'sms',        'GH¢500/day. If exceeded, non-transactional messages are suppressed and an admin is alerted. A runaway reminder loop can otherwise drain the balance overnight.', false, false),
  ('sms.enabled',                       'true',                          'boolean','sms',        'Master kill switch. When false everything is logged but nothing is sent — use during testing to avoid burning credit.', false, false),

  -- Reminders
  ('reminders.enabled',                 'true',                          'boolean','billing',    'Master switch for automated reminders.', false, false),
  ('reminders.expiry_lead_days',        '[2,0]',                         'array',  'billing',    'Days before expiry to send a reminder. 2 = two days ahead, 0 = on expiry day.', false, false),
  ('reminders.send_hour_local',         '9',                             'number', 'billing',    'Hour of day (Africa/Accra) reminders go out. 09:00 gives the customer the whole day to renew.', false, false),
  ('reminders.data_warning_percent',    '80',                            'number', 'billing',    'Warn when this percentage of the data cap is used.', false, false),
  ('reminders.max_per_subscription',    '1',                             'number', 'billing',    'Guards against a scheduling loop spamming one customer.', false, false),

  -- Network / RADIUS behaviour
  ('network.mac_binding_default',       'false',                         'boolean','network',    'Default for new plans. When true, only registered MACs may authenticate.', false, false),
  ('network.default_max_registered_devices', '3',                        'number', 'network',    'Devices that may be registered to one account.', false, false),
  ('network.default_max_simultaneous_devices','1',                       'number', 'network',    'Devices that may be ONLINE at once. Enforced by FreeRADIUS Simultaneous-Use.', false, false),
  ('network.idle_timeout_seconds',      '1800',                          'number', 'network',    'Log a client out after 30 min idle. Frees a simultaneous slot on a shared family account.', false, false),
  ('network.session_timeout_seconds',   'null',                          'number', 'network',    'Forced re-auth interval. NULL = rely on expiry only. Setting this to e.g. 21600 (6h) limits long-lived shared sessions.', false, false),
  ('network.grace_seconds',             '600',                           'number', 'network',    'Keep a session alive this long past expiry so a customer mid-download can renew instead of being cut instantly.', false, false),
  ('network.upstream_capacity_kbps',    '80000',                         'number', 'network',    'Realistic sustained Starlink Mini downlink for capacity planning. Sum of all per-plan ceilings will exceed this; oversubscription is intentional.', false, false),

  ('radius.coa_enabled',                'true',                          'boolean','radius',     'Send CoA/Disconnect to the router for instant expiry and live throttling. Requires /radius incoming on the MikroTik and a LAN-reachable RADIUS server.', false, false),
  ('radius.coa_retries',                '3',                             'number', 'radius',     'Retries before a CoA is logged as failed.', false, false),
  ('radius.degraded_mode_auth',         'true',                          'boolean','radius',     'AUTHORISE FROM LOCAL CACHE when the cloud is unreachable. True means a Starlink outage costs you new signups, not existing subscribers. The alternative locks paying customers out during every obstruction event.', false, false),
  ('radius.degraded_mode_max_age_hours','48',                            'number', 'radius',     'Refuse cached entitlements older than this, so a long outage cannot keep a long-expired account online forever.', false, false),
  ('radius.heartbeat_stale_minutes',    '10',                            'number', 'radius',     'Dashboard flags the site degraded if no accounting or heartbeat arrives within this window.', false, false),
  ('radius.usage_push_batch_size',      '200',                           'number', 'radius',     'Accounting rows per uplink POST.', false, false),
  ('radius.usage_push_interval_seconds','30',                            'number', 'radius',     'Uplink cadence. Short enough that data caps are near-live, long enough not to hammer a slow link.', false, false),
  ('radius.interim_update_seconds',     '300',                           'number', 'radius',     'Accounting-Interim-Interval sent to the router. 5 min balances cap accuracy against row volume: 100 users x 288 rows/day ~ 10M rows/year.', false, false),

  -- Security
  ('security.admin_2fa_required',       'true',                          'boolean','security',   'Refuse admin login until TOTP is enrolled. Non-negotiable for an account that can issue refunds.', false, false),
  ('security.password_min_length',      '12',                            'number', 'security',   'Admin passwords. Customer accounts normally have NO password (phone + OTP).', false, false),
  ('security.argon2_params',            '{"m":65536,"t":3,"p":4}',       'json',   'security',   'Argon2id parameters for admin password hashing.', false, false),
  ('security.session_customer_hours',   '2',                             'number', 'security',   'Customer sessions are short because the device is often shared.', false, false),
  ('security.session_admin_hours',      '8',                             'number', 'security',   'Admin sessions die absolutely at 8h and on any password or TOTP change.', false, false),
  ('security.login_max_failures',       '5',                             'number', 'security',   'Failures before a 15-minute lockout.', false, false),
  ('security.login_lockout_minutes',    '15',                            'number', 'security',   'Lockout duration.', false, false),
  ('security.voucher_max_attempts_per_code', '5',                        'number', 'security',   'Guessing attempts allowed on one code before it is frozen.', false, false),
  ('security.voucher_max_attempts_per_ip_hour', '20',                    'number', 'security',   'Guessing attempts per IP per hour before the IP is blocked.', false, false),
  ('security.csrf_double_submit',       'true',                          'boolean','security',   'Double-submit cookie CSRF protection on every state-changing route.', false, false),
  ('security.trust_proxy_hops',         '1',                             'number', 'security',   'Express trust proxy depth behind the Vercel/CDN edge. Wrong value = rate limits see one giant shared IP.', false, false),

  -- Billing
  ('billing.tax_percent_default',       '0',                             'number', 'billing',    'VAT/NHIL/GETFund on plans. Set to 0 for a small operator below the VAT threshold; confirm your status with GRA and update per plan if it changes.', false, false),
  ('billing.order_prefix',              '"WV"',                          'string', 'billing',    'Order reference prefix.', false, false),
  ('billing.receipt_prefix',            '"WV-R"',                        'string', 'billing',    'Receipt number prefix.', false, false),
  ('billing.refund_requires_second_admin', 'true',                       'boolean','billing',    'A refund must be approved by a different admin than the one who requested it.', false, false),
  ('billing.refund_max_without_approval_pesewas', '1000',                'number', 'billing',    'Refunds up to GH¢10 may be self-approved by an owner (duplicate GH¢5 charges are routine and should be instant).', false, false),
  ('billing.wallet_credit_enabled',     'true',                          'boolean','billing',    'Allow refunds to be settled as wallet credit instead of a Paystack reversal.', false, false),

  -- Resellers (phase 2)
  ('resellers.enabled',                 'false',                         'boolean','resellers',  'Feature flag. Off until phase 2.', false, false),
  ('resellers.default_commission_percent', '10.00',                      'number', 'resellers',  'Default commission for new resellers.', false, false),
  ('resellers.min_payout_pesewas',      '5000',                          'number', 'resellers',  'GH¢50 minimum payout — below that the MoMo transfer fee eats it.', false, false),

  -- Operations
  ('operations.retention.usage_records_months', '13',                    'number', 'operations', 'Raw accounting kept 13 months, then folded into usage_daily.', false, false),
  ('operations.retention.login_attempts_days',  '90',                    'number', 'operations', 'Failed/successful login raw log.', false, false),
  ('operations.retention.security_events_days', '180',                   'number', 'operations', 'Security incident log.', false, false),
  ('operations.retention.audit_log_years',      '7',                     'number', 'operations', 'Change log kept for tax and commercial dispute horizons.', false, false),
  ('operations.backup.edge_daily_hour_local',   '2',                     'number', 'operations', 'Local hour for the edge pg_dump. Off-peak.', false, false),
  ('operations.backup.restore_test_weekday',    '0',                     'number', 'operations', 'Sunday: restore the latest edge dump into a scratch schema and record the result in backup_runs.', false, false),

  -- Legal
  ('legal.privacy_notice_current_version', '1',                          'number', 'legal',      'Version customers accept at signup; stored on users.privacy_notice_id.', false, true),
  ('legal.data_protection_registration', '"PENDING"',                    'string', 'legal',      'Act 843 requires registration with the Data Protection Commission as a data controller. Record the certificate number here once issued.', false, false),
  ('legal.data_controller_name',        '"Wavly WiFi"',                  'string', 'legal',      'Registered data controller name.', false, true)
on conflict (key) do update set
  value = excluded.value, value_type = excluded.value_type,
  category = excluded.category, description = excluded.description,
  is_secret = excluded.is_secret, is_public = excluded.is_public, updated_at = now();


-- ---------------------------------------------------------------------------
-- Rate profiles
-- Values are kbps. The renderer emits Mikrotik-Rate-Limit as
--   "<upload>/<download> <burst-up>/<burst-down> <thresh-up>/<thresh-down> <time>/<time> <priority>"
-- because rx/tx are from the ROUTER's point of view (rx = client upload).
-- ---------------------------------------------------------------------------
insert into rate_profiles
  (name, label, download_kbps, upload_kbps,
   burst_download_kbps, burst_upload_kbps,
   burst_download_threshold_kbps, burst_upload_threshold_kbps,
   burst_download_seconds, burst_upload_seconds,
   min_download_kbps, min_upload_kbps, queue_priority, notes)
values
  ('p-3-1',    '3 / 1 Mbps',     3000,  1000,  6000,  2000,  1500,  500,  8,  8,  500,  250, 8,
   'Fair-usage floor and the free trial. Enough for WhatsApp and a slow page load.'),
  ('p-6-3',    '6 / 3 Mbps',     6000,  3000, 12000,  6000,  3000, 1500, 10, 10, 1000,  500, 7,
   'Daily Lite. Comfortable SD video for one device.'),
  ('p-10-5',  '10 / 5 Mbps',    10000,  5000, 20000, 10000,  5000, 2500, 12, 12, 2000, 1000, 6,
   'Daily Plus and Weekly. HD video, video calls.'),
  ('p-12-6',  '12 / 6 Mbps',    12000,  6000, 24000, 12000,  6000, 3000, 15, 15, 3000, 1500, 5,
   'Monthly Basic. The workhorse plan.'),
  ('p-20-10', '20 / 10 Mbps',   20000, 10000, 40000, 20000, 10000, 5000, 15, 15, 5000, 2500, 4,
   'Monthly Plus. Highest ceiling we can honestly promise on a Starlink Mini with ~80 users.'),
  ('fup-4-2',  'FUP 4 / 2 Mbps', 4000,  2000,  null,  null,  null,  null, null, null, 1000,  500, 8,
   'Fair-usage throttle for Monthly Basic after the included allowance. No burst — bursting defeats the point.'),
  ('fup-6-3',  'FUP 6 / 3 Mbps', 6000,  3000,  null,  null,  null,  null, null, null, 1500,  750, 8,
   'Fair-usage throttle for Monthly Plus.'),
  ('suspended','Suspended',          8,     8,  null,  null,  null,  null, null, null,    8,    8, 8,
   'Applied to suspended accounts that must still reach the portal to renew. 8 kbps is the MikroTik floor and is enough for a captive-portal page but nothing else.')
on conflict (name) do update set
  label = excluded.label, download_kbps = excluded.download_kbps, upload_kbps = excluded.upload_kbps,
  burst_download_kbps = excluded.burst_download_kbps, burst_upload_kbps = excluded.burst_upload_kbps,
  burst_download_threshold_kbps = excluded.burst_download_threshold_kbps,
  burst_upload_threshold_kbps = excluded.burst_upload_threshold_kbps,
  burst_download_seconds = excluded.burst_download_seconds, burst_upload_seconds = excluded.burst_upload_seconds,
  min_download_kbps = excluded.min_download_kbps, min_upload_kbps = excluded.min_upload_kbps,
  queue_priority = excluded.queue_priority, notes = excluded.notes, updated_at = now();


-- ---------------------------------------------------------------------------
-- Plans — the GH¢70-100 monthly band plus short-term hooks
-- duration_seconds: day 86400, 3 days 259200, week 604800, 30 days 2592000
-- data_cap_bytes:   GB x 1073741824
-- ---------------------------------------------------------------------------
insert into plans
  (code, name, tagline, description, badge, kind,
   price_pesewas, currency, tax_percent,
   duration_seconds, data_cap_bytes,
   rate_profile_id, fup_enabled, fup_threshold_bytes, fup_rate_profile_id, fup_action,
   max_simultaneous_devices, max_registered_devices, mac_binding_required,
   session_timeout_seconds, idle_timeout_seconds, grace_seconds,
   allow_stacking, allow_early_renewal_days,
   is_active, is_public, is_voucher_eligible, sort_order, current_revision)
values
  ('free-trial', 'Free Trial', 'Try before you pay — 2 hours, no payment needed',
   'Two hours at 500 MB so you can see the speed for yourself before spending anything. One per phone number.',
   null, 'time_and_data',
   0, 'GHS', 0,
   7200, 536870912,
   (select id from rate_profiles where name = 'p-3-1'), false, null, null, 'notify_only',
   1, 1, false,
   null, 900, 0,
   false, 0,
   true, true, false, 10, 1),

  ('day-lite', 'Daily Lite', 'GH¢5 for 24 hours',
   'A full day online for the price of a drink. 3 GB, up to 6 Mbps down. Great for a market day or a visit.',
   null, 'time_and_data',
   500, 'GHS', 0,
   86400, 3221225472,
   (select id from rate_profiles where name = 'p-6-3'), false, null, null, 'notify_only',
   1, 2, false,
   null, 1800, 300,
   false, 0,
   true, true, true, 20, 1),

  ('day-plus', 'Daily Plus', 'GH¢10 for 24 hours, more data',
   'A day of heavier use: 10 GB at up to 10 Mbps. Video calls, streaming, downloads.',
   null, 'time_and_data',
   1000, 'GHS', 0,
   86400, 10737418240,
   (select id from rate_profiles where name = 'p-10-5'), false, null, null, 'notify_only',
   1, 2, false,
   null, 1800, 300,
   false, 0,
   true, true, true, 30, 1),

  ('week-1', 'Weekly', 'GH¢25 for 7 days',
   'Seven days, 30 GB, up to 10 Mbps. The best value if you are around for a short stay.',
   'Popular with visitors', 'time_and_data',
   2500, 'GHS', 0,
   604800, 32212254720,
   (select id from rate_profiles where name = 'p-10-5'), false, null, null, 'notify_only',
   1, 2, false,
   null, 1800, 600,
   true, 3,
   true, true, true, 40, 1),

  ('month-basic', 'Monthly Basic', 'GH¢70 for 30 days',
   'Our standard monthly plan. 100 GB at up to 12 Mbps. After 100 GB you stay connected at 4 Mbps until the month ends — you are never cut off without warning.',
   'Most popular', 'time_and_data',
   7000, 'GHS', 0,
   2592000, 107374182400,
   (select id from rate_profiles where name = 'p-12-6'), true, 107374182400,
   (select id from rate_profiles where name = 'fup-4-2'), 'throttle',
   1, 3, false,
   null, 1800, 600,
   true, 10,
   true, true, true, 50, 1),

  ('month-plus', 'Monthly Plus', 'GH¢100 for 30 days',
   'For a household or a heavy user. 250 GB at up to 20 Mbps, two devices online at once. After 250 GB you stay connected at 6 Mbps.',
   'Best for families', 'time_and_data',
   10000, 'GHS', 0,
   2592000, 268435456000,
   (select id from rate_profiles where name = 'p-20-10'), true, 268435456000,
   (select id from rate_profiles where name = 'fup-6-3'), 'throttle',
   2, 4, false,
   null, 1800, 600,
   true, 10,
   true, true, true, 60, 1),

  ('data-10gb', '10 GB Bundle', 'GH¢20 for 10 GB, use it when you like',
   'A data-first bundle: 10 GB at up to 10 Mbps, valid for 90 days rather than a fixed clock. Good if you connect only occasionally but want a bigger allowance than a daily plan.',
   null, 'time_and_data',
   2000, 'GHS', 0,
   7776000, 10737418240,
   (select id from rate_profiles where name = 'p-10-5'), false, null, null, 'notify_only',
   1, 2, false,
   null, 3600, 300,
   true, 30,
   true, true, true, 70, 1)
on conflict (code) do update set
  name = excluded.name, tagline = excluded.tagline, description = excluded.description,
  badge = excluded.badge, kind = excluded.kind, price_pesewas = excluded.price_pesewas,
  duration_seconds = excluded.duration_seconds, data_cap_bytes = excluded.data_cap_bytes,
  rate_profile_id = excluded.rate_profile_id, fup_enabled = excluded.fup_enabled,
  fup_threshold_bytes = excluded.fup_threshold_bytes, fup_rate_profile_id = excluded.fup_rate_profile_id,
  fup_action = excluded.fup_action,
  max_simultaneous_devices = excluded.max_simultaneous_devices,
  max_registered_devices = excluded.max_registered_devices,
  idle_timeout_seconds = excluded.idle_timeout_seconds, grace_seconds = excluded.grace_seconds,
  allow_stacking = excluded.allow_stacking, allow_early_renewal_days = excluded.allow_early_renewal_days,
  sort_order = excluded.sort_order, updated_at = now();


-- ---------------------------------------------------------------------------
-- Add-ons (phase 3, defined now so orders can reference them)
-- ---------------------------------------------------------------------------
insert into addons
  (code, name, description, kind, price_pesewas, data_bytes, duration_seconds,
   extra_devices, stackable, is_active, is_public, sort_order)
values
  ('topup-5gb',   'Extra 5 GB',   'Adds 5 GB to your current plan. Valid until the plan expires.', 'data_topup',     1000,  5368709120, null,   null, true, true, true, 10),
  ('topup-20gb',  'Extra 20 GB',  'Adds 20 GB to your current plan. Valid until the plan expires.', 'data_topup',    3000, 21474836480, null,   null, true, true, true, 20),
  ('extend-3d',   'Extend 3 days','Adds 3 days to your current expiry date.',                      'time_extension', 1500, null,         259200, null, true, true, true, 30),
  ('extend-7d',   'Extend 7 days','Adds 7 days to your current expiry date.',                      'time_extension', 3000, null,         604800, null, true, true, true, 40),
  ('device-slot', 'Extra device',  'Adds one more device to your account for the current period.',  'device_slot',    1000, null,         null,   1,    true, true, true, 50)
on conflict (code) do update set
  name = excluded.name, description = excluded.description, price_pesewas = excluded.price_pesewas,
  data_bytes = excluded.data_bytes, duration_seconds = excluded.duration_seconds,
  extra_devices = excluded.extra_devices, sort_order = excluded.sort_order, updated_at = now();


-- ---------------------------------------------------------------------------
-- Network rules
-- ---------------------------------------------------------------------------
-- DoH/DoT blocklist. DNS-based blocking is worthless if the client can reach a
-- DNS-over-HTTPS resolver directly, so these go in BEFORE any content rule.
insert into network_rules
  (scope, action, match_type, pattern, enforcement, priority, category, is_active, notes)
values
  ('global','block','domain','dns.google',              'address_list',10,'abuse',true,'Google DoH — bypasses all DNS filtering.'),
  ('global','block','domain','dns.google.com',          'address_list',10,'abuse',true,'Google DoH.'),
  ('global','block','domain','cloudflare-dns.com',      'address_list',10,'abuse',true,'Cloudflare DoH.'),
  ('global','block','domain','one.one.one.one',         'address_list',10,'abuse',true,'Cloudflare DoH.'),
  ('global','block','domain','dns.quad9.net',           'address_list',10,'abuse',true,'Quad9 DoH/DoT.'),
  ('global','block','domain','doh.opendns.com',         'address_list',10,'abuse',true,'OpenDNS DoH.'),
  ('global','block','domain','dns.adguard.com',         'address_list',10,'abuse',true,'AdGuard DoH.'),
  ('global','block','domain','doh.dns.apple.com',       'address_list',10,'abuse',true,'Apple DoH — iOS enables this automatically when the resolver supports it.'),
  ('global','block','domain','mozilla.cloudflare-dns.com','address_list',10,'abuse',true,'Firefox TRR.'),
  ('global','block','domain','dns.alidns.com',          'address_list',10,'abuse',true,'AliDNS DoH.'),
  ('global','block','domain','doh.pub',                 'address_list',10,'abuse',true,'DNSPod DoH.'),
  ('global','block','cidr','1.1.1.1/32',                'address_list',11,'abuse',true,'Cloudflare resolver IP. Block the IP too, not just the name.'),
  ('global','block','cidr','8.8.8.8/32',                'address_list',11,'abuse',true,'Google resolver IP.'),
  ('global','block','cidr','9.9.9.9/32',                'address_list',11,'abuse',true,'Quad9 resolver IP.'),
  ('global','block','cidr','208.67.222.222/32',         'address_list',11,'abuse',true,'OpenDNS resolver IP.')
on conflict do nothing;

-- Bandwidth-hog example, seeded INACTIVE so it is visible in the dashboard but
-- does not take effect until the operator decides. Video CDNs on the cheap daily
-- plans are the main threat to a Starlink Mini shared by a whole street.
insert into network_rules
  (scope, plan_id, action, match_type, pattern, enforcement, priority, category, is_active, notes)
select 'plan', p.id, 'block', 'domain_suffix', 'netflix.com', 'address_list', 50, 'bandwidth_hog', false,
       'EXAMPLE — inactive. Turn on for the GH¢5 plan if one household is eating the uplink. Blocking SNI only stops the app, not the website; enough for a fair-use policy.'
from plans p where p.code = 'day-lite'
on conflict do nothing;

-- The walled garden itself. Only domains a CUSTOMER DEVICE must reach while
-- UNAUTHENTICATED belong here. Arkesel is deliberately absent: SMS is sent from
-- our server, never from the customer's browser, so opening sms.arkesel.com to
-- unauthenticated clients would be a free SMS relay for anyone in range.
insert into network_rules
  (scope, action, match_type, pattern, enforcement, priority, category, is_active, notes)
values
  ('global','allow','domain','portal.wavlywifi.com',        'walled_garden',1,'walled_garden',true,'The captive portal itself.'),
  ('global','allow','domain','wavlywifi.com',               'walled_garden',1,'walled_garden',true,'Marketing site and privacy notice.'),
  ('global','allow','domain','api.paystack.co',             'walled_garden',1,'walled_garden',true,'Only needed if we ever use Paystack Inline JS from the customer device. Server-side charges do not need it.'),
  ('global','allow','domain','js.paystack.co',              'walled_garden',1,'walled_garden',true,'Paystack Inline JS bundle.'),
  ('global','allow','domain','standard.paystack.co',        'walled_garden',1,'walled_garden',true,'Paystack hosted checkout, used as the fallback when MoMo push fails.'),
  ('global','allow','domain','checkout.paystack.com',       'walled_garden',1,'walled_garden',true,'Paystack hosted checkout.'),
  ('global','allow','domain','checkout.paystack.co',        'walled_garden',1,'walled_garden',true,'Paystack hosted checkout (alt).'),
  ('global','allow','domain','fonts.gstatic.com',           'walled_garden',9,'walled_garden',false,'INACTIVE by default. The portal self-hosts its font so this never needs opening.'),
  ('global','allow','domain','connectivitycheck.gstatic.com','walled_garden',2,'walled_garden',true,'Android captive-portal detection. Without it Android shows "no internet" and some devices refuse to open the login page.'),
  ('global','allow','domain','captive.apple.com',           'walled_garden',2,'walled_garden',true,'iOS/macOS captive-portal detection (204 response).'),
  ('global','allow','domain','www.apple.com',               'walled_garden',2,'walled_garden',true,'iOS captive network assistant path.'),
  ('global','allow','domain','msftconnecttest.com',         'walled_garden',2,'walled_garden',true,'Windows NCSI captive-portal detection.'),
  ('global','allow','domain','connectivitycheck.platform.hicloud.com','walled_garden',2,'walled_garden',true,'Huawei/Honor captive-portal detection — common on the handsets in this market.')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- NAS registry (the MikroTik). The shared secret is a REFERENCE, resolved on the
-- edge node from its environment. It is never stored here.
-- ---------------------------------------------------------------------------
insert into nas_devices
  (site_id, name, shortname, kind, ip_address, model, routeros_version,
   shared_secret_ref, coa_enabled, coa_port, status, firmware_notes)
select s.id, 'nkawie-hap-ax3', 'nkawie-gw', 'mikrotik', '192.168.88.1'::inet,
       'hAP ax3', '7.16.2', 'edge:env:RADIUS_SECRET_NKAWIE01', true, 3799, 'active',
       'Main gateway. Starlink Mini on ether1 (WAN), hotspot on wlan1 + ether2-5 bridge. LAN 192.168.88.0/24, hotspot pool 192.168.89.0/24.'
from sites s where s.code = 'nkawie-01'
on conflict (name) do update set
  model = excluded.model, routeros_version = excluded.routeros_version,
  coa_port = excluded.coa_port, firmware_notes = excluded.firmware_notes, updated_at = now();


-- ---------------------------------------------------------------------------
-- SMS templates. Bodies are written to fit ONE 160-character GSM-7 segment
-- after substitution — each extra segment is another Arkesel charge.
-- Note: the GH¢ sign is NOT in GSM-7 and forces UCS-2 (70 chars/segment), so
-- customer-facing templates use "GHS" instead. That single character choice
-- roughly halves SMS cost.
-- ---------------------------------------------------------------------------
insert into message_templates (key, channel, locale, title, body, variables, category, max_segments) values
  ('sms.otp', 'sms', 'en', 'One-time code',
   'Wavly WiFi: your code is {{code}}. It expires in {{ttl_minutes}} min. Never share it - not even with our staff.',
   '[{"name":"code","example":"482913","required":true},{"name":"ttl_minutes","example":"5","required":true}]'::jsonb,
   'otp', 1),

  ('sms.welcome', 'sms', 'en', 'Account activated',
   'Wavly WiFi: you are connected! {{plan_name}} active until {{expiry}}. Your Wi-Fi login is {{username}}. Questions? Call {{support_phone}}.',
   '[{"name":"plan_name","required":true},{"name":"expiry","required":true},{"name":"username","required":true},{"name":"support_phone","required":true}]'::jsonb,
   'operational', 1),

  ('sms.receipt.paid', 'sms', 'en', 'Payment receipt',
   'Wavly WiFi: GHS {{amount}} received. {{plan_name}} until {{expiry}}. Receipt {{receipt_number}}. Thank you!',
   '[{"name":"amount","example":"70.00","required":true},{"name":"plan_name","required":true},{"name":"expiry","required":true},{"name":"receipt_number","required":true}]'::jsonb,
   'receipt', 1),

  ('sms.reminder.expiry_d2', 'sms', 'en', 'Expiry in 2 days',
   'Wavly WiFi: {{plan_name}} expires in 2 days on {{expiry}}. Renew now at {{portal_url}} and keep your number.',
   '[{"name":"plan_name","required":true},{"name":"expiry","required":true},{"name":"portal_url","required":true}]'::jsonb,
   'reminder', 1),

  ('sms.reminder.expiry_d0', 'sms', 'en', 'Expiring today',
   'Wavly WiFi: your {{plan_name}} expires today. Renew in under a minute at {{portal_url}} to stay connected.',
   '[{"name":"plan_name","required":true},{"name":"portal_url","required":true}]'::jsonb,
   'reminder', 1),

  ('sms.expired', 'sms', 'en', 'Plan expired',
   'Wavly WiFi: your plan has expired. Renew at {{portal_url}} - your login {{username}} is unchanged.',
   '[{"name":"portal_url","required":true},{"name":"username","required":true}]'::jsonb,
   'reminder', 1),

  ('sms.data.warning', 'sms', 'en', 'Data running low',
   'Wavly WiFi: you have used {{percent}}% of your {{allowance}}. {{remaining}} left. Expires {{expiry}}.',
   '[{"name":"percent","required":true},{"name":"allowance","required":true},{"name":"remaining","required":true},{"name":"expiry","required":true}]'::jsonb,
   'reminder', 1),

  ('sms.fup.throttled', 'sms', 'en', 'Speed reduced',
   'Wavly WiFi: you have used your {{allowance}}. Speed is reduced until {{expiry}} but you are still connected. Add data at {{portal_url}}.',
   '[{"name":"allowance","required":true},{"name":"expiry","required":true},{"name":"portal_url","required":true}]'::jsonb,
   'operational', 1),

  ('sms.payment.failed', 'sms', 'en', 'Payment not confirmed',
   'Wavly WiFi: we could not confirm your GHS {{amount}} payment. Nothing extra will be taken. Check {{portal_url}}/account or call {{support_phone}}.',
   '[{"name":"amount","required":true},{"name":"portal_url","required":true},{"name":"support_phone","required":true}]'::jsonb,
   'operational', 1),

  ('sms.voucher.redeemed', 'sms', 'en', 'Voucher activated',
   'Wavly WiFi: voucher {{code_tail}} activated. {{plan_name}} until {{expiry}}. Receipt {{receipt_number}}.',
   '[{"name":"code_tail","required":true},{"name":"plan_name","required":true},{"name":"expiry","required":true},{"name":"receipt_number","required":true}]'::jsonb,
   'receipt', 1),

  ('sms.refund.credited', 'sms', 'en', 'Refund credited',
   'Wavly WiFi: GHS {{amount}} has been credited to your wallet. Reference {{reference}}. Sorry for the trouble.',
   '[{"name":"amount","required":true},{"name":"reference","required":true}]'::jsonb,
   'receipt', 1),

  ('sms.security.new_device', 'sms', 'en', 'New device on your account',
   'Wavly WiFi: a new device connected to your account. If this was not you, call {{support_phone}} right away.',
   '[{"name":"support_phone","required":true}]'::jsonb,
   'security', 1),

  ('sms.outage', 'sms', 'en', 'Service notice',
   'Wavly WiFi: we are aware of a service problem and are working on it. Your active time will be extended to make up for it. Thank you for your patience.',
   '[]'::jsonb,
   'operational', 1)
on conflict (key) do update set
  title = excluded.title, body = excluded.body, variables = excluded.variables,
  category = excluded.category, max_segments = excluded.max_segments, updated_at = now();


-- ---------------------------------------------------------------------------
-- Sanity checks that run as part of the seed
-- ---------------------------------------------------------------------------
do $$
declare
  bad_plans int;
  bad_rl    int;
begin
  select count(*) into bad_plans
  from plans p
  where p.is_active and p.deleted_at is null
    and (p.duration_seconds is null and p.data_cap_bytes is null);

  if bad_plans > 0 then
    raise exception 'seed integrity: % active plan(s) have neither a time limit nor a data cap', bad_plans;
  end if;

  select count(*) into bad_rl
  from rate_profiles
  where download_kbps < upload_kbps;

  if bad_rl > 0 then
    raise exception 'seed integrity: % rate profile(s) have download slower than upload — check you did not swap rx/tx', bad_rl;
  end if;
end;
$$;

commit;

-- Report what landed.
select 'sites'             as what, count(*) as rows from sites
union all select 'settings',          count(*) from settings
union all select 'rate_profiles',     count(*) from rate_profiles
union all select 'plans',             count(*) from plans
union all select 'addons',            count(*) from addons
union all select 'network_rules',     count(*) from network_rules
union all select 'message_templates', count(*) from message_templates
union all select 'nas_devices',       count(*) from nas_devices
union all select 'privacy_notices',   count(*) from privacy_notices
order by 1;
