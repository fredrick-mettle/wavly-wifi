"use client";

import React, { useState } from "react";
import {
  Check, Clock, Database, Gauge, Layers, Pencil, Plus, Smartphone, Trash2, Users, X,
} from "lucide-react";
import { useAdmin } from "../context";
import { Modal, Spinner, StatusPill, TONES } from "../ui";
import { dataLabel, durationLabel, money } from "@/lib/format";
import type { Plan } from "@/lib/types";

const ACCENTS: Record<string, { grad: string; soft: string; text: string; hex: string }> = {
  violet: { grad: "from-brand-400 to-brand-700", soft: "bg-brand-50", text: "text-brand-700", hex: "#7159f4" },
  teal: { grad: "from-mint-300 to-mint-600", soft: "bg-mint-50", text: "text-mint-700", hex: "#16ae85" },
  amber: { grad: "from-sand-300 to-sand-500", soft: "bg-sand-50", text: "text-sand-600", hex: "#fb7c18" },
  blue: { grad: "from-sky-400 to-blue-600", soft: "bg-sky-50", text: "text-sky-700", hex: "#3b82f6" },
};

type PlanForm = {
  id?: string; name: string; description: string; price: number; duration_minutes: number;
  data_limit_mb: number | ""; speed_mbps: number; device_limit: number;
  sort_order: number; accent: string; is_active: boolean;
};

const blank: PlanForm = {
  name: "", description: "", price: 5, duration_minutes: 60, data_limit_mb: 500,
  speed_mbps: 10, device_limit: 1, sort_order: 5, accent: "violet", is_active: true,
};

export default function PlansView() {
  const { snap, run, busy } = useAdmin();
  const [form, setForm] = useState<PlanForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [toDelete, setToDelete] = useState<Plan | null>(null);

  const openNew = () => { setForm({ ...blank, sort_order: snap.plans.length + 1, accent: ["violet", "teal", "amber", "blue"][snap.plans.length % 4] }); setIsNew(true); };
  const openEdit = (p: Plan) => { setForm({ ...p, data_limit_mb: p.data_limit_mb ?? "" }); setIsNew(false); };

  async function save() {
    if (!form) return;
    const data = await run({ type: "plans.save", plan: { ...form } }, isNew ? "Plan created" : "Plan updated");
    if (data !== null) setForm(null);
  }

  async function toggleActive(p: Plan) {
    await run({ type: "plans.save", plan: { ...p, is_active: !p.is_active } }, `${p.name} ${p.is_active ? "disabled" : "enabled"}`);
  }

  async function remove() {
    if (!toDelete) return;
    const data = await run({ type: "plans.delete", id: toDelete.id }, "Plan deleted");
    if (data !== null) setToDelete(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-600">Pricing & packages</p>
          <h2 className="mt-1.5 font-display text-[26px] font-extrabold tracking-tight text-slate-900">Plans</h2>
          <p className="mt-1 text-xs text-slate-500">The passes guests see on the captive portal. Changes appear instantly.</p>
        </div>
        <button onClick={openNew} className="btn-primary !py-2"><Plus className="h-4 w-4" /> New plan</button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[...snap.plans].sort((a, b) => a.sort_order - b.sort_order).map((p) => {
          const a = ACCENTS[p.accent] ?? ACCENTS.violet;
          const sold = snap.vouchers.filter((v) => v.plan_id === p.id && v.status !== "revoked").length;
          return (
            <div key={p.id} className="card relative overflow-hidden">
              <div className={`h-1.5 w-full bg-gradient-to-r ${a.grad}`} />
              <div className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${a.soft} ${a.text}`}><Layers className="h-4 w-4" /></div>
                  <StatusPill status={p.is_active ? "active" : "ended"} label={p.is_active ? "Active" : "Hidden"} />
                </div>
                <h3 className="mt-4 font-display text-[17px] font-extrabold text-slate-900">{p.name}</h3>
                <p className="mt-1 min-h-[34px] text-[11px] leading-relaxed text-slate-500">{p.description || "No description"}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="font-display text-[28px] font-extrabold tracking-tight text-slate-900">{money(p.price, snap.hotspot.currency)}</span>
                  <span className="text-[11px] text-slate-400">/ pass</span>
                </div>
                <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
                  {[
                    { icon: Clock, label: "Validity", value: durationLabel(p.duration_minutes) },
                    { icon: Database, label: "Data", value: dataLabel(p.data_limit_mb) },
                    { icon: Gauge, label: "Speed", value: `${p.speed_mbps} Mbps` },
                    { icon: Smartphone, label: "Devices", value: String(p.device_limit) },
                  ].map((x) => (
                    <div key={x.label} className="flex items-center gap-2.5 text-[11px]">
                      <x.icon className="h-3.5 w-3.5 text-slate-400" />
                      <span className="flex-1 text-slate-500">{x.label}</span>
                      <span className="font-bold text-slate-700">{x.value}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[10px] text-slate-500"><strong className="font-bold text-slate-700">{sold}</strong> vouchers issued</p>
                <div className="mt-4 flex items-center gap-2">
                  <button onClick={() => openEdit(p)} className="btn-ghost flex-1 !py-2 !text-xs"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  <button onClick={() => toggleActive(p)} className="icon-btn" title={p.is_active ? "Disable" : "Enable"}>{p.is_active ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}</button>
                  <button onClick={() => setToDelete(p)} className="icon-btn hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </div>
          );
        })}
        <button onClick={openNew} className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-white/50 p-6 text-slate-400 transition hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-600">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><Plus className="h-5 w-5" /></span>
          <span className="font-display text-sm font-bold">Create a new plan</span>
          <span className="max-w-[180px] text-center text-[11px] leading-relaxed">Add a time or data-limited pass for your guests.</span>
        </button>
      </div>

      <div className="card flex flex-wrap items-center gap-4 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Users className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-slate-800">Plans are live on the guest portal</p>
          <p className="mt-0.5 text-xs text-slate-500">Only plans marked Active are shown to guests buying a pass. Disabled plans stay available to existing vouchers.</p>
        </div>
        <a href="/" target="_blank" className="btn-ghost !py-2">Preview portal</a>
      </div>

      {/* Create / edit modal */}
      <Modal open={Boolean(form)} onClose={() => setForm(null)} title={isNew ? "Create a plan" : "Edit plan"}
        subtitle="Changes are reflected on the captive portal immediately." wide
        footer={<>
          <button onClick={() => setForm(null)} className="btn-ghost !py-2">Cancel</button>
          <button onClick={save} disabled={busy} className="btn-primary !py-2">{busy ? <Spinner /> : <Check className="h-4 w-4" />} Save plan</button>
        </>}>
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><label className="field-label">Plan name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Weekend Pass" className="input" /></div>
            <div className="sm:col-span-2"><label className="field-label">Short description</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this pass good for?" className="input" /></div>
            <div><label className="field-label">Price ({snap.hotspot.currency})</label><input type="number" min="0" step="0.5" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} className="input" /></div>
            <div><label className="field-label">Validity (minutes)</label><input type="number" min="0" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: Number(e.target.value) })} className="input" /><p className="mt-1 text-[10px] text-slate-400">60 = 1 hour · 1440 = 1 day · 0 = no expiry</p></div>
            <div><label className="field-label">Data cap (MB)</label><input type="number" min="0" value={form.data_limit_mb === "" ? "" : form.data_limit_mb} onChange={(e) => setForm({ ...form, data_limit_mb: e.target.value === "" ? "" : Number(e.target.value) })} placeholder="Leave blank for unlimited" className="input" /><p className="mt-1 text-[10px] text-slate-400">1024 MB = 1 GB · blank = unlimited</p></div>
            <div><label className="field-label">Speed cap (Mbps)</label><input type="number" min="1" value={form.speed_mbps} onChange={(e) => setForm({ ...form, speed_mbps: Number(e.target.value) })} className="input" /></div>
            <div><label className="field-label">Device limit</label><input type="number" min="1" value={form.device_limit} onChange={(e) => setForm({ ...form, device_limit: Number(e.target.value) })} className="input" /></div>
            <div><label className="field-label">Display order</label><input type="number" min="0" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} className="input" /></div>
            <div><label className="field-label">Card colour</label>
              <div className="flex gap-2 pt-1">
                {Object.entries(ACCENTS).map(([key, a]) => (
                  <button key={key} onClick={() => setForm({ ...form, accent: key })} className={`h-9 w-9 rounded-xl bg-gradient-to-br ${a.grad} transition ${form.accent === key ? "ring-2 ring-slate-900 ring-offset-2" : "opacity-70 hover:opacity-100"}`} aria-label={key} />
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div><p className="text-xs font-bold text-slate-800">Visible to guests</p><p className="text-[10px] text-slate-500">Show this plan on the portal</p></div>
              <button onClick={() => setForm({ ...form, is_active: !form.is_active })} className={`relative h-6 w-11 rounded-full transition ${form.is_active ? "bg-brand-600" : "bg-slate-300"}`}>
                <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all ${form.is_active ? "left-6" : "left-1"}`} />
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={Boolean(toDelete)} onClose={() => setToDelete(null)} title="Delete this plan?"
        subtitle="Plans with vouchers attached cannot be deleted — disable them instead."
        footer={<>
          <button onClick={() => setToDelete(null)} className="btn-ghost !py-2">Keep plan</button>
          <button onClick={remove} disabled={busy} className="btn-danger !py-2">{busy ? <Spinner /> : <Trash2 className="h-4 w-4" />} Delete plan</button>
        </>}>
        <p className="text-sm text-slate-600">You&apos;re about to delete <strong className="font-bold text-slate-900">{toDelete?.name}</strong>. This can&apos;t be undone.</p>
      </Modal>
    </div>
  );
}
