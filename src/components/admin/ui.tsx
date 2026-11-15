"use client";

import React, { useEffect, useState } from "react";
import {
  Check, Copy, Loader2, X, AlertCircle, CheckCircle2, type LucideIcon,
} from "lucide-react";
import type { Toast } from "./context";

export const TONES = {
  violet: { bg: "bg-brand-50", text: "text-brand-700", solid: "bg-brand-600", ring: "ring-brand-200", hex: "#7159f4", soft: "bg-brand-50/70" },
  teal: { bg: "bg-mint-50", text: "text-mint-700", solid: "bg-mint-500", ring: "ring-mint-200", hex: "#16ae85", soft: "bg-mint-50/70" },
  amber: { bg: "bg-sand-50", text: "text-sand-600", solid: "bg-sand-400", ring: "ring-sand-200", hex: "#fb7c18", soft: "bg-sand-50/70" },
  blue: { bg: "bg-sky-50", text: "text-sky-700", solid: "bg-sky-500", ring: "ring-sky-200", hex: "#3b82f6", soft: "bg-sky-50/70" },
  rose: { bg: "bg-rose-50", text: "text-rose-700", solid: "bg-rose-500", ring: "ring-rose-200", hex: "#f43f5e", soft: "bg-rose-50/70" },
  slate: { bg: "bg-slate-100", text: "text-slate-600", solid: "bg-slate-500", ring: "ring-slate-200", hex: "#64748b", soft: "bg-slate-50" },
} as const;
export type Tone = keyof typeof TONES;

const STATUS_STYLE: Record<string, string> = {
  active: "bg-mint-50 text-mint-700 ring-1 ring-mint-200",
  used: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
  revoked: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
  expired: "bg-sand-50 text-sand-600 ring-1 ring-sand-200",
  ended: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
  online: "bg-mint-50 text-mint-700 ring-1 ring-mint-200",
  offline: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`chip capitalize ${STATUS_STYLE[status] ?? "bg-slate-100 text-slate-600 ring-1 ring-slate-200"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label ?? status}
    </span>
  );
}

export function StatCard({
  label, value, sub, icon: Icon, tone = "violet", delta,
}: {
  label: string; value: string | number; sub?: string; icon: LucideIcon;
  tone?: Tone; delta?: { value: string; up?: boolean };
}) {
  const t = TONES[tone];
  return (
    <div className="card relative overflow-hidden p-5">
      <div className="pointer-events-none absolute -bottom-10 -right-8 h-28 w-28 rounded-full bg-gradient-to-br from-slate-100 to-transparent opacity-70" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</p>
          <p className="mt-2 truncate font-display text-[27px] font-extrabold leading-none tracking-tight text-slate-900 tabular">{value}</p>
        </div>
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${t.bg} ${t.text}`}>
          <Icon className="h-5 w-5" strokeWidth={2} />
        </div>
      </div>
      <div className="relative mt-4 flex items-center gap-2 text-xs">
        {delta && (
          <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-bold ${delta.up ? "bg-mint-50 text-mint-700" : "bg-rose-50 text-rose-600"}`}>
            {delta.up ? "↑" : "↓"} {delta.value}
          </span>
        )}
        {sub && <span className="truncate text-slate-400">{sub}</span>}
      </div>
    </div>
  );
}

export function SectionHead({
  title, subtitle, action,
}: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div>
        <h2 className="font-display text-[15px] font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Modal({
  open, onClose, title, subtitle, children, footer, wide = false,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/60 backdrop-blur-sm animate-[fadeUp_.2s_ease-out]" onClick={onClose} />
      <div className={`relative z-10 max-h-[88vh] w-full ${wide ? "max-w-3xl" : "max-w-lg"} overflow-hidden rounded-2xl bg-white shadow-2xl animate-pop`}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div>
            <h3 className="font-display text-lg font-bold text-slate-900">{title}</h3>
            {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="icon-btn no-print" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="scroll-thin max-h-[62vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="no-print flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} />;
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 ${className}`}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
        setDone(true); setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-mint-600" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

export function Toaster({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  const ok = toast.kind === "ok";
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[200] animate-[fadeUp_.25s_ease-out]">
      <div className={`flex max-w-sm items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-card ${ok ? "border-mint-200" : "border-rose-200"}`}>
        {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-mint-600" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />}
        <p className="text-sm font-medium text-slate-700">{toast.text}</p>
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone = "violet", className = "" }: { value: number; tone?: Tone; className?: string }) {
  const t = TONES[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-slate-100 ${className}`}>
      <div className={`h-full rounded-full transition-all duration-500 ${t.solid}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export function AreaChart({
  points, color = "#7159f4", format = (v: number) => String(Math.round(v)), height = 210,
}: {
  points: { label: string; value: number }[]; color?: string;
  format?: (v: number) => string; height?: number;
}) {
  const w = 640, h = height, padL = 42, padR = 14, padT = 16, padB = 30;
  const max = Math.max(...points.map((p) => p.value), 1) * 1.18;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: padL + i * step,
    y: padT + innerH - (p.value / max) * innerH,
    ...p,
  }));
  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1]?.x ?? padL},${padT + innerH} L${padL},${padT + innerH} Z`;
  const gid = `grad-${color.replace("#", "")}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: height }} role="img" aria-label="Usage trend chart">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = padT + innerH - f * innerH;
        return (
          <g key={f}>
            <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#eef0f6" strokeWidth="1" />
            <text x={padL - 8} y={y + 3.5} textAnchor="end" fontSize="9" fill="#a3adc2">{format(max * f)}</text>
          </g>
        );
      })}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r="3.5" fill="#fff" stroke={color} strokeWidth="2">
            <title>{`${c.label}: ${format(c.value)}`}</title>
          </circle>
          <text x={c.x} y={h - 8} textAnchor="middle" fontSize="10" fill="#94a3b8" fontWeight="600">{c.label}</text>
        </g>
      ))}
    </svg>
  );
}

export function Donut({
  segments, centerLabel, centerSub,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel: string; centerSub?: string;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = 54, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative flex items-center justify-center">
      <svg viewBox="0 0 140 140" className="h-[164px] w-[164px] -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#f1f3f9" strokeWidth="16" />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle key={i} cx="70" cy="70" r={r} fill="none" stroke={s.color} strokeWidth="16"
              strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-offset} strokeLinecap="round">
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="absolute text-center">
        <p className="font-display text-2xl font-extrabold text-slate-900 tabular">{centerLabel}</p>
        {centerSub && <p className="text-[11px] font-semibold text-slate-400">{centerSub}</p>}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><Icon className="h-5 w-5" /></div>
      <p className="mt-3 font-display text-sm font-bold text-slate-800">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-slate-400">{text}</p>
    </div>
  );
}
