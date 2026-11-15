"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Ban, ChevronLeft, ChevronRight, Copy, Download, Filter, KeyRound, Plus, Printer,
  RefreshCw, Search, Ticket, X, Check, Loader2,
} from "lucide-react";
import { useAdmin } from "../context";
import { CopyButton, EmptyState, Modal, SectionHead, Spinner, StatusPill } from "../ui";
import { money, shortDate, timeAgo } from "@/lib/format";
import { sendAction } from "@/lib/client";

const STATUSES = ["all", "active", "used", "revoked", "expired"] as const;
const PAGE_SIZE = 10;

export default function VouchersView() {
  const { snap, run, busy, refresh, notify } = useAdmin();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [form, setForm] = useState({ planId: "", quantity: 10, expiresInDays: 30, note: "" });
  const [batch, setBatch] = useState<{ codes: string[]; planName: string; note: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("q")) setQ(params.get("q") || "");
    if (params.get("generate") === "1") {
      setForm((f) => ({ ...f, planId: f.planId || snap.plans[0]?.id || "" }));
      setGenerateOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!form.planId && snap.plans[0]) setForm((f) => ({ ...f, planId: snap.plans[0].id }));
  }, [snap.plans, form.planId]);

  const counts = useMemo(() => ({
    all: snap.vouchers.length,
    active: snap.vouchers.filter((v) => v.status === "active").length,
    used: snap.vouchers.filter((v) => v.status === "used").length,
    revoked: snap.vouchers.filter((v) => v.status === "revoked").length,
    expired: snap.vouchers.filter((v) => v.status === "expired").length,
  }), [snap.vouchers]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return snap.vouchers.filter((v) => {
      if (status !== "all" && v.status !== status) return false;
      if (planFilter !== "all" && v.plan_id !== planFilter) return false;
      if (needle && !`${v.code} ${v.note ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  }, [snap.vouchers, q, status, planFilter]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const planName = (id: string) => snap.plans.find((p) => p.id === id)?.name ?? "Archived plan";
  const planPrice = (id: string) => Number(snap.plans.find((p) => p.id === id)?.price ?? 0);

  async function generate() {
    const data = await run({
      type: "vouchers.generate", planId: form.planId, quantity: form.quantity,
      expiresInDays: form.expiresInDays, note: form.note,
    }, `${form.quantity} voucher${form.quantity === 1 ? "" : "s"} generated`);
    if (data) {
      setGenerateOpen(false);
      setBatch({ codes: data.codes, planName: planName(form.planId), note: form.note });
      setPage(0);
    }
  }

  function downloadCsv(codes: string[], label: string) {
    const header = ["code", "plan", "status", "issued_at"];
    const lines = [header.join(","), ...codes.map((c) => [c, `"${label.replace(/"/g, '""')}"`, "active", new Date().toISOString()].join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `wavly-vouchers-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportAll() {
    downloadCsv(filtered.map((v) => v.code), "Wavly WiFi");
    notify(`Exported ${filtered.length} vouchers as CSV`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-600">Access management</p>
          <h2 className="mt-1.5 font-display text-[26px] font-extrabold tracking-tight text-slate-900">Vouchers</h2>
          <p className="mt-1 text-xs text-slate-500">Issue, search and revoke the codes guests use to get online.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportAll} className="btn-ghost !py-2"><Download className="h-4 w-4" /> Export CSV</button>
          <button onClick={() => setGenerateOpen(true)} className="btn-primary !py-2"><Plus className="h-4 w-4" /> Generate vouchers</button>
        </div>
      </div>

      {/* Mini stats */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { k: "active", label: "Ready to use", tone: "bg-mint-50 text-mint-700", icon: Ticket },
          { k: "used", label: "Redeemed", tone: "bg-brand-50 text-brand-700", icon: KeyRound },
          { k: "revoked", label: "Revoked", tone: "bg-rose-50 text-rose-700", icon: Ban },
          { k: "all", label: "Total issued", tone: "bg-slate-100 text-slate-700", icon: Copy },
        ].map((s) => (
          <button key={s.k} onClick={() => { setStatus(s.k as any); setPage(0); }}
            className={`card flex items-center gap-3 p-4 text-left transition hover:shadow-card ${status === s.k ? "ring-2 ring-brand-300" : ""}`}>
            <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${s.tone}`}><s.icon className="h-4 w-4" /></span>
            <span><span className="block font-display text-xl font-extrabold text-slate-900 tabular">{counts[s.k as keyof typeof counts]}</span><span className="block text-[11px] text-slate-500">{s.label}</span></span>
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
          <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search codes or batch notes…" className="w-full bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400" />
            {q && <button onClick={() => setQ("")}><X className="h-3.5 w-3.5 text-slate-400" /></button>}
          </div>
          <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => { setStatus(s); setPage(0); }}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[10px] font-bold capitalize transition ${status === s ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>{s}</button>
            ))}
          </div>
          <select value={planFilter} onChange={(e) => { setPlanFilter(e.target.value); setPage(0); }} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 outline-none focus:border-brand-400">
            <option value="all">All plans</option>
            {snap.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={refresh} className="icon-btn" title="Refresh"><RefreshCw className="h-4 w-4" /></button>
        </div>

        {rows.length === 0 ? <EmptyState icon={Ticket} title="No vouchers found" text="Try a different search or filter, or generate a new batch." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead><tr className="border-y border-slate-100 bg-slate-50/60">
                <th className="th">Voucher code</th><th className="th">Plan</th><th className="th">Status</th>
                <th className="th">Created</th><th className="th">Expires</th><th className="th">Used</th><th className="th text-right">Actions</th>
              </tr></thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id} className="table-row">
                    <td className="td"><div className="flex items-center gap-2"><span className="font-mono text-[12px] font-bold tracking-wide text-slate-800">{v.code}</span><CopyButton text={v.code} label="" /></div>{v.note && <p className="mt-0.5 max-w-[220px] truncate text-[10px] text-slate-400">{v.note}</p>}</td>
                    <td className="td"><p className="font-semibold text-slate-700">{planName(v.plan_id)}</p><p className="text-[10px] text-slate-400">{money(planPrice(v.plan_id), snap.hotspot.currency)}</p></td>
                    <td className="td"><StatusPill status={v.status} /></td>
                    <td className="td"><p className="text-xs">{shortDate(v.created_at)}</p><p className="text-[10px] text-slate-400">{timeAgo(v.created_at)}</p></td>
                    <td className="td text-xs text-slate-500">{v.expires_at ? shortDate(v.expires_at) : "—"}</td>
                    <td className="td text-xs text-slate-500">{v.used_at ? shortDate(v.used_at) : "—"}</td>
                    <td className="td text-right">
                      {v.status === "active" ? (
                        <button disabled={busy} onClick={() => run({ type: "vouchers.revoke", id: v.id }, `${v.code} revoked`)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-bold text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                          <Ban className="h-3 w-3" /> Revoke
                        </button>
                      ) : <span className="text-[10px] text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3.5">
          <p className="text-[11px] text-slate-400">Showing <strong className="text-slate-700">{filtered.length ? currentPage * PAGE_SIZE + 1 : 0}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)}</strong> of <strong className="text-slate-700">{filtered.length}</strong> vouchers</p>
          <div className="flex items-center gap-1.5">
            <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="icon-btn disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
            <span className="px-2 text-[11px] font-bold text-slate-600 tabular">{currentPage + 1} / {pages}</span>
            <button disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} className="icon-btn disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      </div>

      {/* Generate modal */}
      <Modal open={generateOpen} onClose={() => setGenerateOpen(false)} title="Generate vouchers"
        subtitle="Create a batch of unique, ready-to-use access codes."
        footer={<>
          <button onClick={() => setGenerateOpen(false)} className="btn-ghost !py-2">Cancel</button>
          <button onClick={generate} disabled={busy || !form.planId} className="btn-primary !py-2">{busy ? <Spinner /> : <Ticket className="h-4 w-4" />} Generate {form.quantity}</button>
        </>}>
        <div className="space-y-4">
          <div>
            <label className="field-label">Plan</label>
            <select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })} className="input">
              {snap.plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price, snap.hotspot.currency)}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">How many codes?</label>
            <input type="number" min={1} max={100} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} className="input" />
            <div className="mt-2 flex gap-2">
              {[10, 25, 50, 100].map((n) => (
                <button key={n} onClick={() => setForm({ ...form, quantity: n })} className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold transition ${form.quantity === n ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500 hover:border-slate-300"}`}>{n}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="field-label">Valid for (days)</label><input type="number" min={1} max={365} value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) || 30 })} className="input" /></div>
            <div><label className="field-label">Batch note</label><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Front desk, Nov" className="input" /></div>
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-brand-50 px-3.5 py-3 text-[11px] leading-relaxed text-brand-800">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Codes follow the <code className="mx-1 rounded bg-white px-1 font-mono font-bold">WAVLY-XXXX-XXXX</code> format. Each code is single-use and tied to the selected plan. You can copy, print or export them after generation.
          </div>
        </div>
      </Modal>

      {/* Generated batch */}
      <Modal open={Boolean(batch)} onClose={() => setBatch(null)} title={`${batch?.codes.length ?? 0} vouchers ready`}
        subtitle={`${batch?.planName ?? ""} · ${batch?.note || "No batch note"}`} wide
        footer={<>
          <button onClick={() => downloadCsv(batch?.codes ?? [], batch?.planName ?? "")} className="btn-ghost !py-2"><Download className="h-4 w-4" /> CSV</button>
          <button onClick={() => window.print()} className="btn-ghost !py-2"><Printer className="h-4 w-4" /> Print</button>
          <button onClick={async () => { try { await navigator.clipboard.writeText((batch?.codes ?? []).join("\n")); notify("All codes copied"); } catch { notify("Could not copy", "err"); } }} className="btn-ghost !py-2"><Copy className="h-4 w-4" /> Copy all</button>
          <button onClick={() => setBatch(null)} className="btn-primary !py-2"><Check className="h-4 w-4" /> Done</button>
        </>}>
        {batch && (
          <div className="print-target">
            <div className="mb-4 hidden print-only">
              <p className="font-display text-xl font-extrabold text-slate-900">Wavly WiFi · {batch.planName}</p>
              <p className="text-xs text-slate-500">{batch.codes.length} access codes · {new Date().toLocaleDateString("en-GB")}</p>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {batch.codes.map((c) => (
                <div key={c} className="print-sheet flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                  <div><p className="font-mono text-[12px] font-bold tracking-wide text-slate-800">{c}</p><p className="mt-0.5 text-[9px] uppercase tracking-wide text-slate-400">{batch.planName}</p></div>
                  <CopyButton text={c} label="" className="no-print" />
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
