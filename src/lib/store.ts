import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildDemoSnapshot, buildUsage, HOTSPOT_ID,
} from "./demo";
import type {
  ActivityEvent, Device, HotspotSettings, Plan, Session, Snapshot, Voucher,
} from "./types";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isLive = () => Boolean(URL && KEY);

let _client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (!URL || !KEY) throw new Error("Supabase is not configured");
  if (!_client) _client = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

let _demo: Snapshot | null = null;
function demo(): Snapshot {
  if (!_demo) _demo = buildDemoSnapshot();
  return _demo;
}

/**
 * In demo mode there is no database, so the browser carries the authoritative
 * snapshot. Each action sends its current snapshot; the server replays the
 * mutation against it and returns the updated one. This keeps demo-mode
 * mutations coherent even across separate serverless invocations.
 */
export function setDemoState(snapshot: Snapshot): void {
  if (isLive() || !snapshot || !Array.isArray(snapshot.plans)) return;
  _demo = snapshot;
}

const MIN = 60_000;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

export function normalizeCode(raw: string): string {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 13) return `${s.slice(0, 5)}-${s.slice(5, 9)}-${s.slice(9, 13)}`;
  if (s.length === 8) return `WAVLY-${s.slice(0, 4)}-${s.slice(4, 8)}`;
  return s;
}

function makeCode(): string {
  const part = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
  };
  return `WAVLY-${part()}-${part()}`;
}

function refreshUsage(s: Snapshot) {
  s.usage = buildUsage(s.sessions, s.vouchers, s.plans);
  s.generated_at = nowIso();
}

function addEvent(s: Snapshot | SupabaseClient, type: string, message: string, meta: Record<string, unknown> | null = null) {
  if (s instanceof Object && "events" in s) {
    const snap = s as Snapshot;
    snap.events.unshift({ id: newId(), type, message, metadata: meta, created_at: nowIso() });
    snap.events = snap.events.slice(0, 60);
    return Promise.resolve();
  }
  return (s as SupabaseClient).from("wavly_events").insert({ type, message, metadata: meta ?? {}, created_at: nowIso() });
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

async function seedLive(client: SupabaseClient) {
  const { count, error } = await client.from("wavly_plans").select("id", { count: "exact", head: true });
  if (error) throw error;
  if ((count ?? 0) > 0) return;
  const d = buildDemoSnapshot();
  const h = d.hotspot;
  const steps: Promise<any>[] = [
    Promise.resolve(client.from("wavly_hotspot").upsert({
      id: h.id, name: h.name, ssid: h.ssid, location: h.location, currency: h.currency,
      portal_title: h.portal_title, welcome_message: h.welcome_message, tos_text: h.tos_text,
      max_download_mbps: h.max_download_mbps, max_upload_mbps: h.max_upload_mbps,
      session_timeout_minutes: h.session_timeout_minutes, is_active: h.is_active, updated_at: nowIso(),
    })),
    Promise.resolve(client.from("wavly_plans").upsert(d.plans.map((p) => ({
      id: p.id, name: p.name, description: p.description, price: p.price,
      duration_minutes: p.duration_minutes, data_limit_mb: p.data_limit_mb, speed_mbps: p.speed_mbps,
      device_limit: p.device_limit, is_active: p.is_active, sort_order: p.sort_order, accent: p.accent,
      created_at: p.created_at,
    })))),
    Promise.resolve(client.from("wavly_devices").upsert(d.devices.map((x) => ({
      id: x.id, mac: x.mac, vendor: x.vendor, label: x.label,
      first_seen_at: x.first_seen_at, last_seen_at: x.last_seen_at,
    })), { onConflict: "mac" })),
    Promise.resolve(client.from("wavly_vouchers").upsert(d.vouchers.map((v) => ({
      id: v.id, code: v.code, plan_id: v.plan_id, status: v.status, batch_id: v.batch_id,
      note: v.note, created_at: v.created_at, expires_at: v.expires_at, used_at: v.used_at,
    })), { onConflict: "code" })),
    Promise.resolve(client.from("wavly_events").insert(d.events.map((e) => ({
      id: e.id, type: e.type, message: e.message, metadata: e.metadata ?? {}, created_at: e.created_at,
    })))),
  ];
  for (const p of steps) {
    const { error: err } = await p;
    if (err) throw err;
  }
  const { error: sessErr } = await client.from("wavly_sessions").upsert(d.sessions.map((x) => ({
    id: x.id, voucher_id: x.voucher_id, device_id: x.device_id, plan_id: x.plan_id,
    started_at: x.started_at, expires_at: x.expires_at, ended_at: x.ended_at,
    status: x.status, bytes_used: x.bytes_used, ip: x.ip,
  })));
  if (sessErr) throw sessErr;
}

export async function getSnapshot(): Promise<Snapshot> {
  if (!isLive()) {
    const s = demo();
    s.generated_at = nowIso();
    return s;
  }
  try {
    const client = db();
    await seedLive(client);
    const [h, p, v, d, s, e] = await Promise.all([
      client.from("wavly_hotspot").select("*").limit(1),
      client.from("wavly_plans").select("*").order("sort_order", { ascending: true }),
      client.from("wavly_vouchers").select("*").order("created_at", { ascending: false }).limit(400),
      client.from("wavly_devices").select("*").limit(400),
      client.from("wavly_sessions").select("*").order("started_at", { ascending: false }).limit(400),
      client.from("wavly_events").select("*").order("created_at", { ascending: false }).limit(60),
    ]);
    const err = h.error || p.error || v.error || d.error || s.error || e.error;
    if (err) throw err;
    const hotspot = (h.data?.[0] as HotspotSettings) ?? (buildDemoSnapshot().hotspot as HotspotSettings);
    const plans = (p.data ?? []) as Plan[];
    const vouchers = (v.data ?? []) as Voucher[];
    const devices = (d.data ?? []) as Device[];
    const sessions = (s.data ?? []) as Session[];
    const events = (e.data ?? []) as ActivityEvent[];
    return {
      mode: "live", hotspot, plans, vouchers, devices, sessions, events,
      usage: buildUsage(sessions, vouchers, plans), generated_at: nowIso(),
    };
  } catch {
    const s = demo();
    s.generated_at = nowIso();
    return s;
  }
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

function vendorForMac(mac: string): string {
  const map: Record<string, string> = {
    "A4": "Apple iPhone", "3C": "Samsung", "64": "Xiaomi", "24": "Huawei", "F8": "Google Pixel",
    "94": "OnePlus", "B0": "Dell Laptop", "9C": "Tecno", "D0": "iPad", "14": "MacBook",
  };
  return map[mac.slice(0, 2).toUpperCase()] ?? "Guest device";
}

function demoDevice(snap: Snapshot, mac: string): Device {
  let device = snap.devices.find((d) => d.mac.toUpperCase() === mac.toUpperCase());
  if (!device) {
    device = {
      id: newId(), mac: mac.toUpperCase(), vendor: vendorForMac(mac), label: null,
      first_seen_at: nowIso(), last_seen_at: nowIso(),
    };
    snap.devices.unshift(device);
  } else {
    device.last_seen_at = nowIso();
  }
  return device;
}

async function liveDevice(client: SupabaseClient, mac: string): Promise<Device> {
  const { data, error } = await client.from("wavly_devices").upsert({
    mac: mac.toUpperCase(), vendor: vendorForMac(mac), last_seen_at: nowIso(),
  }, { onConflict: "mac" }).select("*").single();
  if (error) throw new Error(error.message);
  return data as Device;
}

function validateVoucher(voucher: Voucher | undefined | null): asserts voucher is Voucher {
  if (!voucher) throw new Error("We couldn't find that voucher code. Please check it and try again.");
  if (voucher.status === "used") throw new Error("This voucher has already been used. Ask for a fresh one at the front desk.");
  if (voucher.status === "revoked") throw new Error("This voucher has been revoked. Please contact staff.");
  if (voucher.status === "expired") throw new Error("This voucher has expired.");
  if (voucher.expires_at && new Date(voucher.expires_at).getTime() < Date.now()) {
    throw new Error("This voucher has expired. Please purchase a new plan.");
  }
}

function sessionFrom(plan: Plan, voucher: Voucher, device: Device, mac: string, ip: string): Session {
  return {
    id: newId(),
    voucher_id: voucher.id,
    device_id: device.id,
    plan_id: plan.id,
    started_at: nowIso(),
    expires_at: plan.duration_minutes > 0 ? new Date(Date.now() + plan.duration_minutes * MIN).toISOString() : null,
    ended_at: null,
    status: "active",
    bytes_used: 0,
    ip: ip || `10.20.0.${Math.floor(Math.random() * 200) + 10}`,
  };
}

/* ------------------------------------------------------------------ */
/* Portal actions                                                      */
/* ------------------------------------------------------------------ */

export async function connectWithVoucher(input: { code: string; mac?: string; ip?: string }) {
  const mac = (input.mac || "A4:83:E7:2B:19:4C").toUpperCase();
  const ip = input.ip || "";
  const code = normalizeCode(input.code);

  if (!isLive()) {
    const snap = demo();
    const voucher = snap.vouchers.find((v) => normalizeCode(v.code) === code);
    validateVoucher(voucher);
    const plan = snap.plans.find((p) => p.id === voucher.plan_id);
    if (!plan) throw new Error("The plan for this voucher is no longer available.");
    const device = demoDevice(snap, mac);
    const session = sessionFrom(plan, voucher, device, mac, ip);
    snap.sessions.unshift(session);
    voucher.status = "used";
    voucher.used_at = nowIso();
    await addEvent(snap, "connect", `${device.vendor} connected using ${voucher.code} · ${plan.name}`);
    refreshUsage(snap);
    return { session, voucher, plan, device };
  }

  const client = db();
  const { data: found, error: findErr } = await client.from("wavly_vouchers")
    .select("*").eq("code", code).maybeSingle();
  if (findErr) throw new Error(findErr.message);
  const voucher = found as Voucher | null;
  validateVoucher(voucher);
  const { data: foundPlan } = await client.from("wavly_plans").select("*").eq("id", voucher.plan_id).maybeSingle();
  const plan = foundPlan as Plan | null;
  if (!plan) throw new Error("The plan for this voucher is no longer available.");
  const device = await liveDevice(client, mac);
  const session = sessionFrom(plan, voucher, device, mac, ip);
  const { error: sessErr } = await client.from("wavly_sessions").insert(session);
  if (sessErr) throw new Error(sessErr.message);
  const { error: vErr } = await client.from("wavly_vouchers")
    .update({ status: "used", used_at: nowIso() }).eq("id", voucher.id);
  if (vErr) throw new Error(vErr.message);
  await addEvent(client, "connect", `${device.vendor} connected using ${voucher.code} · ${plan.name}`);
  return { session, voucher, plan, device };
}

export async function purchasePlan(input: {
  planId: string; msisdn?: string; network?: string; mac?: string; ip?: string;
}) {
  const code = makeCode();
  const note = input.network ? `${input.network} · ${input.msisdn || "guest"}` : "Portal purchase";

  if (!isLive()) {
    const snap = demo();
    const plan = snap.plans.find((p) => p.id === input.planId);
    if (!plan) throw new Error("That plan is no longer available.");
    const voucher: Voucher = {
      id: newId(), code, plan_id: plan.id, status: "active", batch_id: null, note,
      created_at: nowIso(), expires_at: new Date(Date.now() + 30 * 24 * 60 * MIN).toISOString(), used_at: null,
    };
    snap.vouchers.unshift(voucher);
    await addEvent(snap, "purchase", `Mobile Money purchase · ${plan.name} · ${input.network || "MoMo"}`);
    refreshUsage(snap);
  } else {
    const client = db();
    const { error } = await client.from("wavly_vouchers").insert({
      code, plan_id: input.planId, status: "active", note,
      created_at: nowIso(), expires_at: new Date(Date.now() + 30 * 24 * 60 * MIN).toISOString(),
    });
    if (error) throw new Error(error.message);
    await addEvent(client, "purchase", `Mobile Money purchase · ${input.network || "MoMo"}`);
  }

  const connected = await connectWithVoucher({ code, mac: input.mac, ip: input.ip });
  return { ...connected, purchasedCode: code };
}

/* ------------------------------------------------------------------ */
/* Admin actions                                                       */
/* ------------------------------------------------------------------ */

export async function generateVouchers(input: {
  planId: string; quantity: number; note?: string; expiresInDays?: number;
}) {
  const quantity = Math.max(1, Math.min(100, Math.floor(Number(input.quantity) || 1)));
  const days = Math.max(1, Math.min(365, Math.floor(Number(input.expiresInDays) || 30)));
  const batchId = newId();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * MIN).toISOString();
  const note = input.note?.trim() || null;

  if (!isLive()) {
    const snap = demo();
    const plan = snap.plans.find((p) => p.id === input.planId);
    if (!plan) throw new Error("Choose a valid plan.");
    const codes: string[] = [];
    const created: Voucher[] = [];
    for (let i = 0; i < quantity; i++) {
      let code = makeCode();
      while (snap.vouchers.some((v) => v.code === code) || codes.includes(code)) code = makeCode();
      codes.push(code);
      created.push({
        id: newId(), code, plan_id: input.planId, status: "active", batch_id: batchId, note,
        created_at: nowIso(), expires_at: expiresAt, used_at: null,
      });
    }
    snap.vouchers.unshift(...created);
    await addEvent(snap, "voucher", `Generated ${quantity} ${plan.name} voucher${quantity === 1 ? "" : "s"}`);
    refreshUsage(snap);
    return { codes, batchId };
  }

  const client = db();
  const existing = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < quantity; i++) {
    let code = makeCode();
    while (existing.has(code)) code = makeCode();
    existing.add(code);
    rows.push({
      code, plan_id: input.planId, status: "active", batch_id: batchId, note,
      created_at: nowIso(), expires_at: expiresAt,
    });
  }
  const { error } = await client.from("wavly_vouchers").insert(rows);
  if (error) throw new Error(error.message);
  await addEvent(client, "voucher", `Generated ${quantity} voucher${quantity === 1 ? "" : "s"}`);
  return { codes: Array.from(existing), batchId };
}

export async function revokeVoucher(id: string) {
  if (!isLive()) {
    const snap = demo();
    const v = snap.vouchers.find((x) => x.id === id);
    if (!v) throw new Error("Voucher not found.");
    if (v.status === "used") throw new Error("Used vouchers cannot be revoked.");
    v.status = "revoked";
    await addEvent(snap, "voucher", `Voucher ${v.code} was revoked`);
    return;
  }
  const { error } = await db().from("wavly_vouchers").update({ status: "revoked" }).eq("id", id).eq("status", "active");
  if (error) throw new Error(error.message);
  await addEvent(db(), "voucher", "A voucher was revoked by an administrator");
}

export async function disconnectSession(id: string) {
  if (!isLive()) {
    const snap = demo();
    const s = snap.sessions.find((x) => x.id === id);
    if (!s) throw new Error("Session not found.");
    s.status = "ended";
    s.ended_at = nowIso();
    await addEvent(snap, "disconnect", "An administrator ended a live session");
    return;
  }
  const { error } = await db().from("wavly_sessions").update({ status: "ended", ended_at: nowIso() }).eq("id", id);
  if (error) throw new Error(error.message);
  await addEvent(db(), "disconnect", "An administrator ended a live session");
}

export async function savePlan(input: Partial<Plan>) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Give the plan a name.");
  const payload = {
    name,
    description: String(input.description || "").trim(),
    price: Math.max(0, Number(input.price) || 0),
    duration_minutes: Math.max(0, Math.floor(Number(input.duration_minutes) || 0)),
    data_limit_mb: (() => {
      const raw = input.data_limit_mb as number | null | "" | undefined;
      return raw === null || raw === undefined || raw === ""
        ? null
        : Math.max(0, Math.floor(Number(raw)));
    })(),
    speed_mbps: Math.max(1, Math.floor(Number(input.speed_mbps) || 10)),
    device_limit: Math.max(1, Math.floor(Number(input.device_limit) || 1)),
    is_active: input.is_active !== false,
    sort_order: Math.floor(Number(input.sort_order) || 0),
    accent: String(input.accent || "violet"),
  };
  if (!isLive()) {
    const snap = demo();
    const existing = snap.plans.find((p) => p.id === input.id);
    if (existing) Object.assign(existing, payload);
    else snap.plans.push({ id: newId(), ...payload, created_at: nowIso() } as Plan);
    snap.plans.sort((a, b) => a.sort_order - b.sort_order);
    await addEvent(snap, "system", `Plan "${name}" was ${existing ? "updated" : "created"}`);
    return;
  }
  const row: Record<string, unknown> = input.id
    ? { id: input.id, ...payload }
    : { ...payload, created_at: nowIso() };
  const { error } = await db().from("wavly_plans").upsert(row);
  if (error) throw new Error(error.message);
  await addEvent(db(), "system", `Plan "${name}" saved`);
}

export async function deletePlan(id: string) {
  if (!isLive()) {
    const snap = demo();
    if (snap.vouchers.some((v) => v.plan_id === id)) throw new Error("This plan has vouchers attached, so it can't be deleted. Disable it instead.");
    snap.plans = snap.plans.filter((p) => p.id !== id);
    await addEvent(snap, "system", "A plan was deleted");
    return;
  }
  const { error } = await db().from("wavly_plans").delete().eq("id", id);
  if (error) throw new Error("This plan has vouchers attached. Disable it instead.");
  await addEvent(db(), "system", "A plan was deleted");
}

export async function saveSettings(input: Partial<HotspotSettings>) {
  const payload = {
    name: String(input.name || "Wavly WiFi").trim(),
    ssid: String(input.ssid || "WAVLY-GUEST").trim(),
    location: String(input.location || "").trim(),
    currency: String(input.currency || "GHS").trim(),
    portal_title: String(input.portal_title || "Welcome to Wavly WiFi").trim(),
    welcome_message: String(input.welcome_message || "").trim(),
    tos_text: String(input.tos_text || "").trim(),
    max_download_mbps: Math.max(1, Math.floor(Number(input.max_download_mbps) || 30)),
    max_upload_mbps: Math.max(1, Math.floor(Number(input.max_upload_mbps) || 10)),
    session_timeout_minutes: Math.max(1, Math.floor(Number(input.session_timeout_minutes) || 15)),
    is_active: input.is_active !== false,
    updated_at: nowIso(),
  };
  if (!isLive()) {
    Object.assign(demo().hotspot, payload);
    await addEvent(demo(), "system", "Hotspot settings were updated");
    return;
  }
  const { error } = await db().from("wavly_hotspot").update(payload).eq("id", input.id || HOTSPOT_ID);
  if (error) throw new Error(error.message);
  await addEvent(db(), "system", "Hotspot settings were updated");
}
