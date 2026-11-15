"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity, ArrowRight, ArrowUpRight, CircleDot, CreditCard, Database, Gauge,
  Plus, Radio, RefreshCw, Ticket, TrendingUp, Users, Wifi, Zap,
} from "lucide-react";
import { useAdmin } from "../context";
import { AreaChart, Donut, EmptyState, ProgressBar, SectionHead, Spinner, StatCard, StatusPill, TONES, type Tone } from "../ui";
import { compactMoney, dataLabel, formatBytes, maskMac, money, shortDate, timeAgo, timeLeft } from "@/lib/format";

const EVENT_ICON: Record<string, { icon: typeof Activity; tone: Tone }> = {
  connect: { icon: Wifi, tone: "teal" },
  purchase: { icon: CreditCard, tone: "violet" },
  voucher: { icon: Ticket, tone: "blue" },
  disconnect: { icon: Radio, tone: "slate" },
  system: { icon: Gauge, tone: "amber" },
  alert: { icon: Activity, tone: "rose" },
};

export default function OverviewView() {
  const { snap, run, busy, refresh } = useAdmin();
  const [metric, setMetric] = useState<"connections" | "revenue" | "gb">("connections");

  const active = useMemo(() => snap.sessions.filter((s) => s.status === "active")
    .sort((a, b) => +new Date(b.started_at) - +new Date(a.started_at)), [snap.sessions]);
  const issued = useMemo(() => snap.vouchers.filter((v) => v.status !== "revoked"), [snap.vouchers]);
  const revenue = snap.usage.reduce((a, u) => a + u.revenue, 0);
  const gb = snap.usage.reduce((a, u) => a + u.gb, 0);
  const connections = snap.usage.reduce((a, u) => a + u.connections, 0);
  const deviceCount = snap.devices.length;

  const chartPoints = snap.usage.map((u) => ({
    label: u.label,
    value: metric === "connections" ? u.connections : metric === "revenue" ? u.revenue : u.gb,
  }));
  const chartColor = metric === "revenue" ? "#16ae85" : metric === "gb" ? "#fb7c18" : "#7159f4";
  const chartFormat = (v: number) => metric === "revenue" ? compactMoney(v, snap.hotspot.currency)
    : metric === "gb" ? `${v.toFixed(1)} GB` : String(Math.round(v));

  const donutSegments = snap.plans.map((p) => ({
    label: p.name,
    value: snap.vouchers.filter((v) => v.plan_id === p.id && v.status !== "revoked").length,
    color: TONES[(p.accent as Tone) in TONES ? (p.accent as Tone) : "violet"].hex,
  })).filter((s) => s.value > 0);

  const planName = (id: string) => snap.plans.find((p) => p.id === id)?.name ?? "Unknown plan";
  const deviceFor = (id: string) => snap.devices.find((d) => d.id === id);

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-600">
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
          <h2 className="mt-1.5 font-display text-[26px] font-extrabold tracking-tight text-slate-900">Network overview</h2>
          <p className="mt-1 text-xs text-slate-500">Here&apos;s what&apos;s happening at <strong className="font-semibold text-slate-700">{snap.hotspot.name}</strong> today.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={refresh} className="btn-ghost !py-2"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
          <Link href="/admin/vouchers?generate=1" className="btn-primary !py-2"><Plus className="h-4 w-4" /> Generate vouchers</Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active sessions" value={active.length} sub={`${deviceCount} registered devices`} icon={Radio} tone="violet" delta={{ value: "12.4%", up: true }} />
        <StatCard label="Connections · 7 days" value={connections} sub="across all access points" icon={Activity} tone="blue" delta={{ value: "8.1%", up: true }} />
        <StatCard label="Revenue · 7 days" value={money(revenue, snap.hotspot.currency)} sub={`${issued.length} vouchers issued`} icon={CreditCard} tone="teal" delta={{ value: "18.6%", up: true }} />
        <StatCard label="Data served · 7 days" value={`${gb.toFixed(1)} GB`} sub={`${snap.hotspot.max_download_mbps} Mbps down cap`} icon={Database} tone="amber" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* Chart */}
          <div className="card overflow-hidden">
            <SectionHead title="Network activity" subtitle="Last 7 days across all access points" action={
              <div className="flex rounded-lg bg-slate-100 p-0.5">
                {([["connections", "Connections"], ["revenue", "Revenue"], ["gb", "Data"]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setMetric(k)} className={`rounded-md px-2.5 py-1.5 text-[10px] font-bold transition ${metric === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>{label}</button>
                ))}
              </div>
            } />
            <div className="px-4 pb-3 pt-5 sm:px-6">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="font-display text-3xl font-extrabold text-slate-900 tabular">
                  {metric === "revenue" ? money(revenue, snap.hotspot.currency) : metric === "gb" ? `${gb.toFixed(1)} GB` : connections}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-mint-600"><TrendingUp className="h-3 w-3" /> +12.4%</span>
              </div>
              <p className="mb-2 text-[11px] text-slate-400">Total for the last 7 days</p>
              <AreaChart points={chartPoints} color={chartColor} format={chartFormat} />
            </div>
          </div>

          {/* Live sessions */}
          <div className="card overflow-hidden">
            <SectionHead title="Live sessions" subtitle={`${active.length} devices currently connected`} action={
              <Link href="/admin/sessions" className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-600 hover:text-brand-800">View all <ArrowRight className="h-3 w-3" /></Link>
            } />
            {active.length === 0 ? <EmptyState icon={Radio} title="No active sessions" text="Devices will appear here as soon as guests connect." /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px]">
                  <thead><tr className="border-y border-slate-100 bg-slate-50/60"><th className="th">Device</th><th className="th">Plan</th><th className="th">Data used</th><th className="th">Time left</th><th className="th">Status</th><th className="th" /></tr></thead>
                  <tbody>
                    {active.slice(0, 5).map((s) => {
                      const d = deviceFor(s.device_id);
                      const plan = snap.plans.find((p) => p.id === s.plan_id);
                      const pct = plan?.data_limit_mb ? Math.min(100, (s.bytes_used / (1024 * 1024) / plan.data_limit_mb) * 100) : 18;
                      return (
                        <tr key={s.id} className="table-row">
                          <td className="td"><p className="font-semibold text-slate-800">{d?.vendor ?? "Guest device"}</p><p className="font-mono text-[10px] text-slate-400">{maskMac(d?.mac ?? "")}</p></td>
                          <td className="td"><span className="font-medium">{planName(s.plan_id)}</span></td>
                          <td className="td"><p className="text-xs font-semibold tabular">{formatBytes(s.bytes_used)}</p><ProgressBar value={pct} className="mt-1.5 !h-1 w-24" /></td>
                          <td className="td"><span className="text-xs font-semibold text-slate-600">{timeLeft(s.expires_at)}</span></td>
                          <td className="td"><StatusPill status="active" label="Online" /></td>
                          <td className="td text-right">
                            <button disabled={busy} onClick={() => run({ type: "sessions.disconnect", id: s.id }, "Session disconnected")}
                              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-bold text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                              Disconnect
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          {/* Plan mix */}
          <div className="card overflow-hidden">
            <SectionHead title="Plan mix" subtitle="Vouchers issued by plan" />
            <div className="px-5 pb-5 pt-3">
              <Donut segments={donutSegments} centerLabel={String(issued.length)} centerSub="vouchers" />
              <div className="mt-3 space-y-2">
                {donutSegments.map((s) => {
                  const t = Object.values(TONES).find((x) => x.hex === s.color);
                  return (
                    <div key={s.label} className="flex items-center gap-2 text-xs">
                      <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                      <span className="flex-1 truncate text-slate-600">{s.label}</span>
                      <span className="font-bold text-slate-800 tabular">{s.value}</span>
                      <span className="w-9 text-right text-[10px] text-slate-400">{Math.round((s.value / (issued.length || 1)) * 100)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Activity */}
          <div className="card overflow-hidden">
            <SectionHead title="Recent activity" subtitle="Live network event log" />
            <div className="divide-y divide-slate-100">
              {snap.events.slice(0, 6).map((e) => {
                const meta = EVENT_ICON[e.type] ?? EVENT_ICON.system;
                const t = TONES[meta.tone];
                return (
                  <div key={e.id} className="flex items-start gap-3 px-5 py-3">
                    <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${t.bg} ${t.text}`}><meta.icon className="h-3.5 w-3.5" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] leading-snug text-slate-700">{e.message}</p>
                      <p className="mt-1 text-[10px] text-slate-400">{timeAgo(e.created_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Health */}
          <div className="card overflow-hidden bg-gradient-to-br from-ink to-[#161d3a] !border-white/10 p-5 text-white">
            <div className="flex items-center gap-2"><CircleDot className="h-4 w-4 text-mint-300" /><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/60">Access point health</p></div>
            <p className="mt-4 font-display text-2xl font-extrabold">All systems nominal</p>
            <p className="mt-1 text-xs text-white/45">3 of 3 access points reporting · 18 ms latency</p>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[["Uptime", "99.9%"], ["Signal", "-42 dBm"], ["Clients", String(active.length)]].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-white/[0.07] px-2 py-2"><p className="text-[9px] uppercase tracking-wide text-white/40">{k}</p><p className="mt-0.5 text-xs font-bold">{v}</p></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
