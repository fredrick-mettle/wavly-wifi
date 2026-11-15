"use client";

import React, { useEffect, useState } from "react";
import {
  Check, Copy, Database, ExternalLink, FileText, Gauge, Globe, KeyRound, MapPin,
  Radio, Router, Save, Server, ShieldCheck, Wifi,
} from "lucide-react";
import { useAdmin } from "../context";
import { SectionHead, Spinner } from "../ui";
import type { HotspotSettings } from "@/lib/types";

const SNIPPET = `# Authorize a device from your router / controller
curl -X POST https://<your-domain>/api/action \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "portal.connect",
    "code": "WAVLY-XXXX-XXXX",
    "mac": "A4:83:E7:2B:19:4C",
    "tosAccepted": true
  }'`;

export default function SettingsView() {
  const { snap, run, busy, notify } = useAdmin();
  const [form, setForm] = useState<HotspotSettings>(snap.hotspot);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setForm(snap.hotspot); }, [snap.hotspot]);
  const set = (key: keyof HotspotSettings, value: string | number | boolean) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    await run({ type: "settings.save", settings: form }, "Hotspot settings saved");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-600">Configuration</p>
          <h2 className="mt-1.5 font-display text-[26px] font-extrabold tracking-tight text-slate-900">Hotspot settings</h2>
          <p className="mt-1 text-xs text-slate-500">Control what guests see and how the network behaves.</p>
        </div>
        <button onClick={save} disabled={busy} className="btn-primary !py-2">{busy ? <Spinner /> : <Save className="h-4 w-4" />} Save changes</button>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="card overflow-hidden">
            <SectionHead title="Hotspot profile" subtitle="Identity of this network and location" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <div><label className="field-label">Hotspot name</label><div className="relative"><Wifi className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={form.name} onChange={(e) => set("name", e.target.value)} className="input !pl-10" /></div></div>
              <div><label className="field-label">Network name (SSID)</label><div className="relative"><Radio className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={form.ssid} onChange={(e) => set("ssid", e.target.value)} className="input !pl-10" /></div></div>
              <div><label className="field-label">Location</label><div className="relative"><MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={form.location} onChange={(e) => set("location", e.target.value)} className="input !pl-10" /></div></div>
              <div><label className="field-label">Currency</label><select value={form.currency} onChange={(e) => set("currency", e.target.value)} className="input"><option value="GHS">GHS — Ghana Cedi (GH₵)</option><option value="USD">USD — US Dollar ($)</option><option value="EUR">EUR — Euro (€)</option><option value="GBP">GBP — Pound (£)</option><option value="NGN">NGN — Naira (₦)</option><option value="KES">KES — Kenyan Shilling</option></select></div>
            </div>
          </div>

          <div className="card overflow-hidden">
            <SectionHead title="Guest portal" subtitle="Copy and terms shown on the splash page" />
            <div className="space-y-4 p-5">
              <div><label className="field-label">Headline</label><input value={form.portal_title} onChange={(e) => set("portal_title", e.target.value)} className="input" /><p className="mt-1 text-[10px] text-slate-400">The last word is highlighted with a gradient on the portal.</p></div>
              <div><label className="field-label">Welcome message</label><textarea rows={2} value={form.welcome_message} onChange={(e) => set("welcome_message", e.target.value)} className="input resize-none" /></div>
              <div><label className="field-label">Terms of service</label><textarea rows={6} value={form.tos_text} onChange={(e) => set("tos_text", e.target.value)} className="input resize-y font-mono !text-[11px] leading-relaxed" /></div>
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div><p className="text-xs font-bold text-slate-800">Portal enabled</p><p className="text-[10px] text-slate-500">Turn off to temporarily close guest access</p></div>
                <button onClick={() => set("is_active", !form.is_active)} className={`relative h-6 w-11 rounded-full transition ${form.is_active ? "bg-brand-600" : "bg-slate-300"}`}>
                  <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all ${form.is_active ? "left-6" : "left-1"}`} />
                </button>
              </div>
            </div>
          </div>

          <div className="card overflow-hidden">
            <SectionHead title="Bandwidth & sessions" subtitle="Fair-use limits applied to every guest" />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              <div><label className="field-label">Max download (Mbps)</label><input type="number" min="1" value={form.max_download_mbps} onChange={(e) => set("max_download_mbps", Number(e.target.value))} className="input" /></div>
              <div><label className="field-label">Max upload (Mbps)</label><input type="number" min="1" value={form.max_upload_mbps} onChange={(e) => set("max_upload_mbps", Number(e.target.value))} className="input" /></div>
              <div><label className="field-label">Idle timeout (min)</label><input type="number" min="1" value={form.session_timeout_minutes} onChange={(e) => set("session_timeout_minutes", Number(e.target.value))} className="input" /></div>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="card overflow-hidden">
            <SectionHead title="Data source" subtitle="Where network state is stored" />
            <div className="p-5">
              <div className={`flex items-center gap-3 rounded-xl border p-3.5 ${snap.mode === "live" ? "border-mint-200 bg-mint-50/60" : "border-sand-200 bg-sand-50/60"}`}>
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${snap.mode === "live" ? "bg-mint-100 text-mint-700" : "bg-sand-100 text-sand-600"}`}><Database className="h-4 w-4" /></div>
                <div><p className="text-xs font-bold text-slate-800">{snap.mode === "live" ? "Connected to Supabase" : "Demo data mode"}</p><p className="text-[10px] text-slate-500">{snap.mode === "live" ? "All changes persist to Postgres" : "In-memory sample data"}</p></div>
              </div>
              <div className="mt-4 space-y-2">
                {[
                  { icon: ShieldCheck, t: "Service-role key stays server-side" },
                  { icon: Server, t: "Row Level Security enabled" },
                  { icon: Globe, t: "API routes proxy all database calls" },
                ].map((x) => <p key={x.t} className="flex items-center gap-2 text-[11px] text-slate-500"><x.icon className="h-3.5 w-3.5 text-slate-400" />{x.t}</p>)}
              </div>
              <div className="mt-4 rounded-lg bg-slate-900 px-3 py-2.5 font-mono text-[10px] leading-relaxed text-slate-300">
                <p className="text-slate-500"># .env.local</p>
                <p>NEXT_PUBLIC_SUPABASE_URL=…</p>
                <p>SUPABASE_SERVICE_ROLE_KEY=…</p>
              </div>
            </div>
          </div>

          <div className="card overflow-hidden">
            <SectionHead title="Router integration" subtitle="Authorize devices from your controller" />
            <div className="p-5">
              <p className="text-[11px] leading-relaxed text-slate-500">Point your access point&apos;s WISPr / external portal to <code className="rounded bg-slate-100 px-1 font-mono text-[10px]">/</code> and pass the client MAC as a query parameter. Redeem codes with the action endpoint:</p>
              <div className="relative mt-3 rounded-xl bg-slate-900 p-3.5">
                <pre className="scroll-thin overflow-x-auto whitespace-pre font-mono text-[9.5px] leading-relaxed text-slate-300">{SNIPPET}</pre>
                <button onClick={async () => { try { await navigator.clipboard.writeText(SNIPPET); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1600); }}
                  className="absolute right-2 top-2 rounded-md bg-white/10 px-2 py-1 text-[9px] font-bold text-white hover:bg-white/20">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
              <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-400"><KeyRound className="mt-0.5 h-3 w-3 shrink-0" /> For production, put this endpoint behind a RADIUS / controller secret and serve the portal over HTTPS.</p>
            </div>
          </div>

          <div className="card overflow-hidden">
            <SectionHead title="Quick links" />
            <div className="divide-y divide-slate-100">
              {[
                { icon: Wifi, label: "Open guest portal", href: "/" },
                { icon: FileText, label: "Voucher batches", href: "/admin/vouchers" },
                { icon: Gauge, label: "Live sessions", href: "/admin/sessions" },
              ].map((x) => (
                <a key={x.label} href={x.href} target={x.href === "/" ? "_blank" : undefined} className="flex items-center gap-3 px-5 py-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-brand-600">
                  <x.icon className="h-3.5 w-3.5 text-slate-400" /> <span className="flex-1">{x.label}</span> <ExternalLink className="h-3 w-3 text-slate-300" />
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
