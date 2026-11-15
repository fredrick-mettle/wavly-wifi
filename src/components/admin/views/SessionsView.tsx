"use client";

import React, { useMemo, useState } from "react";
import {
  Activity, Clock, Database, MonitorSmartphone, Power, Radio, RefreshCw, Search, Wifi, X,
} from "lucide-react";
import { useAdmin } from "../context";
import { AreaChart, EmptyState, ProgressBar, SectionHead, StatCard, StatusPill } from "../ui";
import { formatBytes, maskMac, shortDate, timeAgo, timeLeft } from "@/lib/format";

export default function SessionsView() {
  const { snap, run, busy, refresh } = useAdmin();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "ended">("active");

  const active = snap.sessions.filter((s) => s.status === "active");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todaySessions = snap.sessions.filter((s) => +new Date(s.started_at) >= +today);
  const todayBytes = todaySessions.reduce((a, s) => a + s.bytes_used, 0);
  const avgMinutes = Math.round(
    snap.sessions.filter((s) => s.ended_at).reduce((a, s) => a + (+new Date(s.ended_at!) - +new Date(s.started_at)) / 60000, 0) /
    Math.max(1, snap.sessions.filter((s) => s.ended_at).length)
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return snap.sessions.filter((s) => {
      if (filter !== "all" && (filter === "active" ? s.status !== "active" : s.status === "active")) return false;
      const d = snap.devices.find((x) => x.id === s.device_id);
      const p = snap.plans.find((x) => x.id === s.plan_id);
      if (needle && !`${d?.vendor ?? ""} ${d?.mac ?? ""} ${s.ip ?? ""} ${p?.name ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => +new Date(b.started_at) - +new Date(a.started_at));
  }, [snap, q, filter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-600">Real-time monitoring</p>
          <h2 className="mt-1.5 font-display text-[26px] font-extrabold tracking-tight text-slate-900">Live sessions</h2>
          <p className="mt-1 text-xs text-slate-500">See every device on the network and end sessions when needed.</p>
        </div>
        <button onClick={refresh} className="btn-ghost !py-2"><RefreshCw className="h-4 w-4" /> Refresh</button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Connected now" value={active.length} sub="across 3 access points" icon={Radio} tone="violet" />
        <StatCard label="Sessions today" value={todaySessions.length} sub="includes completed" icon={Activity} tone="blue" />
        <StatCard label="Data today" value={formatBytes(todayBytes)} sub="total upload + download" icon={Database} tone="teal" />
        <StatCard label="Avg. session" value={`${avgMinutes} min`} sub="based on completed sessions" icon={Clock} tone="amber" />
      </div>

      <div className="card overflow-hidden">
        <SectionHead title="Connection trend" subtitle="Sessions started over the last 7 days" />
        <div className="px-4 pb-2 pt-4 sm:px-6"><AreaChart points={snap.usage.map((u) => ({ label: u.label, value: u.connections }))} color="#7159f4" height={170} /></div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search device, MAC, IP or plan…" className="w-full bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400" />
            {q && <button onClick={() => setQ("")}><X className="h-3.5 w-3.5 text-slate-400" /></button>}
          </div>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {(["active", "ended", "all"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-3 py-1.5 text-[10px] font-bold capitalize transition ${filter === f ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>{f}</button>
            ))}
          </div>
          <span className="text-[11px] font-semibold text-slate-400">{rows.length} results</span>
        </div>

        {rows.length === 0 ? <EmptyState icon={MonitorSmartphone} title="No sessions here" text="Adjust the filters or wait for a guest to connect." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px]">
              <thead><tr className="border-y border-slate-100 bg-slate-50/60">
                <th className="th">Device</th><th className="th">Plan</th><th className="th">IP address</th>
                <th className="th">Started</th><th className="th">Data used</th><th className="th">Time remaining</th><th className="th">Status</th><th className="th" />
              </tr></thead>
              <tbody>
                {rows.slice(0, 40).map((s) => {
                  const d = snap.devices.find((x) => x.id === s.device_id);
                  const p = snap.plans.find((x) => x.id === s.plan_id);
                  const pct = p?.data_limit_mb ? Math.min(100, (s.bytes_used / (1024 * 1024) / p.data_limit_mb) * 100) : 12;
                  return (
                    <tr key={s.id} className="table-row">
                      <td className="td"><p className="font-semibold text-slate-800">{d?.vendor ?? "Guest device"}</p><p className="font-mono text-[10px] text-slate-400">{maskMac(d?.mac ?? "")}</p></td>
                      <td className="td"><span className="font-medium">{p?.name ?? "Archived plan"}</span></td>
                      <td className="td font-mono text-[11px] text-slate-500">{s.ip ?? "—"}</td>
                      <td className="td"><p className="text-xs">{shortDate(s.started_at)}</p><p className="text-[10px] text-slate-400">{timeAgo(s.started_at)}</p></td>
                      <td className="td"><p className="text-xs font-semibold tabular">{formatBytes(s.bytes_used)}</p><ProgressBar value={pct} className="mt-1.5 !h-1 w-20" /></td>
                      <td className="td"><span className={`text-xs font-semibold ${s.status === "active" ? "text-slate-700" : "text-slate-400"}`}>{s.status === "active" ? timeLeft(s.expires_at) : "Completed"}</span></td>
                      <td className="td"><StatusPill status={s.status} label={s.status === "active" ? "Online" : "Ended"} /></td>
                      <td className="td text-right">
                        {s.status === "active" ? (
                          <button disabled={busy} onClick={() => run({ type: "sessions.disconnect", id: s.id }, "Session disconnected")}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-bold text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                            <Power className="h-3 w-3" /> End
                          </button>
                        ) : <span className="text-[10px] text-slate-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 40 && <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">Showing the 40 most recent of {rows.length} sessions.</p>}
      </div>
    </div>
  );
}
