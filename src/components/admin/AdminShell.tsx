"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity, Bell, ChevronDown, ExternalLink, LayoutDashboard, Layers, LogOut,
  Menu, Radio, RefreshCw, Search, Settings, ShieldCheck, Ticket, Wifi, X,
} from "lucide-react";
import Logo from "@/components/Logo";
import { sendAction } from "@/lib/client";
import type { Snapshot } from "@/lib/types";
import { AdminProvider, useAdmin } from "./context";
import { Spinner, Toaster } from "./ui";

const NAV = [
  { id: "overview", label: "Overview", href: "/admin", icon: LayoutDashboard },
  { id: "vouchers", label: "Vouchers", href: "/admin/vouchers", icon: Ticket },
  { id: "sessions", label: "Live sessions", href: "/admin/sessions", icon: Radio },
  { id: "plans", label: "Plans & pricing", href: "/admin/plans", icon: Layers },
  { id: "settings", label: "Hotspot settings", href: "/admin/settings", icon: Settings },
];

function Sidebar({ active, mobileOpen, onClose }: { active: string; mobileOpen: boolean; onClose: () => void }) {
  const { snap } = useAdmin();
  const activeSessions = snap.sessions.filter((s) => s.status === "active").length;
  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-ink/60 lg:hidden" onClick={onClose} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[252px] flex-col bg-ink transition-transform duration-300 lg:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-[72px] items-center justify-between px-6">
          <Logo light />
          <button onClick={onClose} className="text-white/50 hover:text-white lg:hidden" aria-label="Close menu"><X className="h-5 w-5" /></button>
        </div>

        <div className="mx-4 mb-5 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.045] px-3 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500/20 text-brand-300"><Wifi className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-bold text-white">{snap.hotspot.name}</p>
            <p className="truncate text-[10px] text-white/40">{snap.hotspot.ssid} · {snap.hotspot.location.split("·")[0].trim()}</p>
          </div>
        </div>

        <p className="px-7 pb-2 text-[9px] font-bold uppercase tracking-[0.18em] text-white/30">Workspace</p>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            return (
              <Link
                key={item.id} href={item.href} onClick={onClose}
                className={`group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold transition-all ${
                  isActive ? "bg-gradient-to-r from-brand-600 to-brand-500 text-white shadow-glow" : "text-white/55 hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                <Icon className="h-[17px] w-[17px]" strokeWidth={isActive ? 2.2 : 1.9} />
                <span className="flex-1">{item.label}</span>
                {item.id === "sessions" && activeSessions > 0 && (
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular ${isActive ? "bg-white/20 text-white" : "bg-white/10 text-white/60"}`}>{activeSessions}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mx-3 mb-3 rounded-xl border border-white/10 bg-white/[0.035] p-3.5">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2 text-mint-400 ring-pulse"><span className="absolute inline-flex h-2 w-2 rounded-full bg-mint-400" /></span>
            <p className="text-[11px] font-bold text-white">Network online</p>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-white/40">All access points responding · 18 ms average latency</p>
          <div className="mt-3 flex items-center gap-1.5 text-[10px] font-semibold text-mint-300">
            <Activity className="h-3 w-3" /> {activeSessions} devices connected
          </div>
        </div>

        <div className="border-t border-white/[0.07] px-5 py-4">
          <div className="flex items-center gap-2 text-[10px] text-white/30">
            <ShieldCheck className="h-3.5 w-3.5" /> Wavly Hotspot Manager v1.0
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({ onMenu, active }: { onMenu: () => void; active: string }) {
  const { snap, refresh, busy } = useAdmin();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const current = NAV.find((n) => n.id === active) ?? NAV[0];

  async function logout() {
    try { await sendAction({ type: "logout" }); } catch { /* ignore */ }
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 flex h-[72px] items-center gap-3 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-xl lg:px-8">
      <button onClick={onMenu} className="icon-btn lg:hidden" aria-label="Open menu"><Menu className="h-4 w-4" /></button>
      <div className="hidden min-w-0 md:block">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Wavly / Console</p>
        <h1 className="truncate font-display text-[15px] font-bold text-slate-900">{current.label}</h1>
      </div>

      <form
        className="ml-auto hidden max-w-xs flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 sm:flex"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/admin/vouchers?q=${encodeURIComponent(q)}`);
        }}
      >
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search voucher codes…"
          className="w-full bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400" />
        <kbd className="hidden rounded border border-slate-200 bg-white px-1 text-[9px] text-slate-400 lg:block">↵</kbd>
      </form>

      <span className={`hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold sm:inline-flex ${snap.mode === "live" ? "bg-mint-50 text-mint-700 ring-1 ring-mint-200" : "bg-sand-50 text-sand-600 ring-1 ring-sand-200"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${snap.mode === "live" ? "bg-mint-500" : "bg-sand-400"}`} />
        {snap.mode === "live" ? "Supabase live" : "Demo data"}
      </span>

      <button onClick={refresh} className="icon-btn" title="Refresh data" aria-label="Refresh">{busy ? <Spinner /> : <RefreshCw className="h-4 w-4" />}</button>
      <Link href="/" target="_blank" className="icon-btn hidden sm:inline-flex" title="Open guest portal" aria-label="Open guest portal"><ExternalLink className="h-4 w-4" /></Link>
      <button className="icon-btn relative hidden sm:inline-flex" aria-label="Notifications">
        <Bell className="h-4 w-4" /><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-rose-500 ring-2 ring-white" />
      </button>

      <div className="relative">
        <button onClick={() => setMenuOpen(!menuOpen)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white py-1.5 pl-1.5 pr-2.5 transition hover:border-slate-300">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-mint-500 text-[10px] font-bold text-white">WA</span>
          <span className="hidden text-left lg:block">
            <span className="block text-[11px] font-bold leading-tight text-slate-800">Wavly Admin</span>
            <span className="block text-[9px] leading-tight text-slate-400">Owner</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-12 z-40 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-card">
            <div className="border-b border-slate-100 px-3 py-2.5">
              <p className="text-xs font-bold text-slate-800">Wavly Admin</p>
              <p className="text-[10px] text-slate-400">admin@wavly.wifi</p>
            </div>
            <button onClick={logout} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function Shell({ active, children }: { active: string; children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { toast } = useAdmin();
  return (
    <div className="min-h-screen bg-[#f6f7fb]">
      <Sidebar active={active} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="lg:pl-[252px]">
        <Topbar onMenu={() => setMobileOpen(true)} active={active} />
        <main className="mx-auto max-w-[1440px] px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
      <Toaster toast={toast} />
    </div>
  );
}

export default function AdminShell({
  initial, active, children,
}: { initial: Snapshot; active: string; children: React.ReactNode }) {
  return <AdminProvider initial={initial}><Shell active={active}>{children}</Shell></AdminProvider>;
}
