import type {
  ActivityEvent, Device, HotspotSettings, Plan, Session, Snapshot, UsagePoint, Voucher,
} from "./types";

export const PLAN_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

export const DEMO_VOUCHER_CODE = "WAVLY-DEMO-2026";
export const HOTSPOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uid = (n: number, salt = 0) => {
  const a = ((n * 2654435761 + salt * 40503) >>> 0).toString(16).padStart(8, "0");
  const b = ((n + salt * 7919) >>> 0).toString(16).padStart(12, "0");
  return `${a.slice(0, 8)}-1a2b-4c3d-8e5f-${b.slice(0, 12)}`;
};

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const VENDORS: [string, string][] = [
  ["Apple iPhone", "A4:83:E7"], ["Samsung Galaxy", "3C:DC:BC"], ["Xiaomi", "64:CC:2E"],
  ["Huawei", "24:69:A5"], ["Google Pixel", "F8:8F:CA"], ["OnePlus", "94:65:2D"],
  ["Dell Laptop", "B0:7B:25"], ["Tecno", "9C:28:EF"], ["Infinix", "70:5A:0F"],
  ["Nintendo Switch", "98:B6:E9"], ["HP Laptop", "3C:52:82"], ["Oppo", "38:78:62"],
  ["iPad", "D0:03:4B"], ["MacBook Pro", "14:7D:DA"], ["Realme", "4C:49:E3"],
  ["Smart TV", "8C:79:F5"], ["Samsung Tablet", "18:3B:0C"], ["Unknown device", "02:00:00"],
];

export function buildUsage(sessions: Session[], vouchers: Voucher[], plans: Plan[]): UsagePoint[] {
  const prices = new Map(plans.map((p) => [p.id, Number(p.price) || 0]));
  const out: UsagePoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - i);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const daySessions = sessions.filter((s) => {
      const t = new Date(s.started_at).getTime();
      return t >= start.getTime() && t < end.getTime();
    });
    const dayVouchers = vouchers.filter((v) => {
      const t = new Date(v.created_at).getTime();
      return t >= start.getTime() && t < end.getTime() && v.status !== "revoked";
    });
    out.push({
      date: start.toISOString().slice(0, 10),
      label: start.toLocaleDateString("en-GB", { weekday: "short" }),
      connections: daySessions.length,
      revenue: dayVouchers.reduce((sum, v) => sum + (prices.get(v.plan_id) ?? 0), 0),
      gb: daySessions.reduce((sum, s) => sum + s.bytes_used, 0) / (1024 * 1024 * 1024),
    });
  }
  return out;
}

export function buildDemoSnapshot(): Snapshot {
  const r = mulberry32(20261115);
  const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)];
  const hex = () => Math.floor(r() * 256).toString(16).padStart(2, "0").toUpperCase();

  const hotspot: HotspotSettings = {
    id: HOTSPOT_ID,
    name: "Wavly Osu Hub",
    ssid: "WAVLY-GUEST",
    location: "Osu, Accra · Greater Accra",
    currency: "GHS",
    portal_title: "Welcome to Wavly WiFi",
    welcome_message: "Fast, affordable internet for everyone. Grab a voucher and you're online in seconds.",
    tos_text:
      "By connecting to Wavly WiFi you agree to use the service responsibly and lawfully. We may apply fair-use bandwidth limits, disconnect abusive devices, and keep basic connection records (device MAC address, session times and data volume) for network operations. The service is provided as-is without any guarantee of uninterrupted availability. Do not use this network for illegal activity, network attacks, or unauthorized access to other systems.",
    max_download_mbps: 30,
    max_upload_mbps: 12,
    session_timeout_minutes: 15,
    is_active: true,
    updated_at: iso(2 * DAY),
  };

  const plans: Plan[] = [
    { id: PLAN_IDS[0], name: "Quick Connect", description: "Perfect for a quick check-in, email or ride hailing.", price: 2, duration_minutes: 60, data_limit_mb: 300, speed_mbps: 5, device_limit: 1, is_active: true, sort_order: 1, accent: "blue", created_at: iso(40 * DAY) },
    { id: PLAN_IDS[1], name: "Day Pass", description: "A full day of browsing, streaming and messaging.", price: 10, duration_minutes: 1440, data_limit_mb: 2048, speed_mbps: 10, device_limit: 2, is_active: true, sort_order: 2, accent: "violet", created_at: iso(40 * DAY) },
    { id: PLAN_IDS[2], name: "Power Week", description: "Seven days of high-speed access for heavy users.", price: 25, duration_minutes: 10080, data_limit_mb: 10240, speed_mbps: 20, device_limit: 3, is_active: true, sort_order: 3, accent: "teal", created_at: iso(40 * DAY) },
    { id: PLAN_IDS[3], name: "Unlimited Month", description: "No data cap for a whole month. Best value.", price: 60, duration_minutes: 43200, data_limit_mb: null, speed_mbps: 30, device_limit: 5, is_active: true, sort_order: 4, accent: "amber", created_at: iso(40 * DAY) },
  ];

  const devices: Device[] = VENDORS.map(([vendor, oui], i) => ({
    id: uid(i + 1, 11),
    mac: `${oui}:${hex()}:${hex()}`,
    vendor,
    label: i === 3 ? "Reception desk" : i === 9 ? "Lounge TV" : null,
    first_seen_at: iso(Math.floor(r() * 12 + 1) * DAY),
    last_seen_at: iso(Math.floor(r() * 90) * MIN),
  }));

  const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = (i: number) => {
    const rr = mulberry32(7000 + i);
    const part = () => Array.from({ length: 4 }, () => codeChars[Math.floor(rr() * codeChars.length)]).join("");
    return `WAVLY-${part()}-${part()}`;
  };

  const vouchers: Voucher[] = [];
  for (let i = 0; i < 78; i++) {
    const created = iso(Math.floor(r() * 13 * DAY) + Math.floor(r() * HOUR));
    const statusRoll = r();
    const status = statusRoll < 0.08 ? "revoked" : statusRoll < 0.24 ? "active" : statusRoll < 0.28 ? "expired" : "used";
    vouchers.push({
      id: uid(i + 1, 22),
      code: code(i),
      plan_id: PLAN_IDS[Math.floor(r() * 4)],
      status,
      batch_id: i < 40 ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      note: null,
      created_at: created,
      expires_at: new Date(new Date(created).getTime() + 30 * DAY).toISOString(),
      used_at: status === "used" ? new Date(new Date(created).getTime() + Math.floor(r() * 6 * HOUR)).toISOString() : null,
    });
  }
  vouchers.unshift({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    code: DEMO_VOUCHER_CODE,
    plan_id: PLAN_IDS[1],
    status: "active",
    batch_id: null,
    note: "Complimentary demo voucher",
    created_at: iso(3 * HOUR),
    expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    used_at: null,
  });

  const sessions: Session[] = [];
  // Live sessions
  for (let i = 0; i < 12; i++) {
    const plan = plans[i % 4];
    const started = Date.now() - Math.floor(r() * 210 + 2) * MIN;
    const device = devices[i];
    sessions.push({
      id: uid(i + 1, 33),
      voucher_id: vouchers[i + 1]?.id ?? null,
      device_id: device.id,
      plan_id: plan.id,
      started_at: new Date(started).toISOString(),
      expires_at: new Date(started + plan.duration_minutes * MIN).toISOString(),
      ended_at: null,
      status: "active",
      bytes_used: Math.floor((r() * 900 + 40) * 1024 * 1024),
      ip: `10.20.0.${20 + i}`,
    });
  }
  // Historical sessions
  for (let i = 0; i < 74; i++) {
    const plan = plans[Math.floor(r() * 4)];
    const started = Date.now() - (Math.floor(r() * 6.8 * DAY) + 2 * HOUR);
    const device = devices[Math.floor(r() * devices.length)];
    const ended = started + Math.min(plan.duration_minutes * MIN, Math.floor((r() * 5 + 0.5) * HOUR));
    sessions.push({
      id: uid(i + 1, 44),
      voucher_id: vouchers[(i + 20) % vouchers.length]?.id ?? null,
      device_id: device.id,
      plan_id: plan.id,
      started_at: new Date(started).toISOString(),
      expires_at: new Date(started + plan.duration_minutes * MIN).toISOString(),
      ended_at: new Date(ended).toISOString(),
      status: "ended",
      bytes_used: Math.floor((r() * 1400 + 60) * 1024 * 1024),
      ip: `10.20.1.${10 + (i % 200)}`,
    });
  }

  const eventTemplates: [string, string][] = [
    ["connect", "New device connected on the Day Pass plan"],
    ["purchase", "Mobile Money purchase · GH₵10.00 · MTN MoMo"],
    ["voucher", "Batch of 25 vouchers generated for Quick Connect"],
    ["disconnect", "Session ended automatically — time limit reached"],
    ["connect", "Returning device reconnected at the Osu hub"],
    ["system", "Router heartbeat healthy · 18 ms latency"],
    ["alert", "Unusual traffic blocked from a guest device"],
    ["purchase", "Mobile Money purchase · GH₵25.00 · Telecel Cash"],
    ["voucher", "Voucher WAVLY-****-**** was revoked by admin"],
    ["system", "Nightly usage report generated"],
    ["connect", "New device connected on the Unlimited Month plan"],
    ["purchase", "Mobile Money purchase · GH₵2.00 · MTN MoMo"],
  ];
  const events: ActivityEvent[] = eventTemplates.map(([type, message], i) => ({
    id: uid(i + 1, 55), type, message, metadata: null,
    created_at: iso(i * 24 * MIN + Math.floor(r() * 18 * MIN)),
  }));

  return {
    mode: "demo",
    hotspot,
    plans: plans.sort((a, b) => a.sort_order - b.sort_order),
    vouchers,
    devices,
    sessions,
    events,
    usage: buildUsage(sessions, vouchers, plans),
    generated_at: new Date().toISOString(),
  };
}
