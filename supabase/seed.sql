-- Optional seed. The app also auto-seeds itself on first request when the
-- wavly_plans table is empty, so running this file is not required.
-- Fixed plan IDs are shared with src/lib/demo.ts.

insert into public.wavly_plans
  (id, name, description, price, duration_minutes, data_limit_mb, speed_mbps, device_limit, is_active, sort_order, accent)
values
  ('11111111-1111-4111-8111-111111111111', 'Quick Connect', 'Perfect for a quick check-in, email or ride hailing.', 2,   60,   300,  5,  1, true, 1, 'blue'),
  ('22222222-2222-4222-8222-222222222222', 'Day Pass',      'A full day of browsing, streaming and messaging.',   10,  1440, 2048, 10, 2, true, 2, 'violet'),
  ('33333333-3333-4333-8333-333333333333', 'Power Week',    'Seven days of high-speed access for heavy users.',  25, 10080, 10240,20, 3, true, 3, 'teal'),
  ('44444444-4444-4444-8444-444444444444', 'Unlimited Month','No data cap for a whole month. Best value.',       60, 43200, null,30, 5, true, 4, 'amber')
on conflict (id) do nothing;

insert into public.wavly_hotspot
  (id, name, ssid, location, currency, portal_title, welcome_message, tos_text,
   max_download_mbps, max_upload_mbps, session_timeout_minutes, is_active)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Wavly Osu Hub', 'WAVLY-GUEST', 'Osu, Accra · Greater Accra', 'GHS',
   'Welcome to Wavly WiFi', 'Fast, affordable internet for everyone. Grab a voucher and you are online in seconds.',
   'By connecting to Wavly WiFi you agree to use the service responsibly and lawfully. We may apply fair-use bandwidth limits, disconnect abusive devices, and keep basic connection records (device MAC address, session times and data volume) for network operations. The service is provided as-is without any guarantee of uninterrupted availability.',
   30, 12, 15, true)
on conflict (id) do nothing;

insert into public.wavly_vouchers (code, plan_id, status, note, expires_at)
values ('WAVLY-DEMO-2026', '22222222-2222-4222-8222-222222222222', 'active', 'Complimentary demo voucher', now() + interval '30 days')
on conflict (code) do nothing;
