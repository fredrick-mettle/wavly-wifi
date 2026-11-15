"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, Wifi, Zap } from "lucide-react";
import Logo from "@/components/Logo";
import { sendAction } from "@/lib/client";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      await sendAction({ type: "login", password });
      const next = new URLSearchParams(window.location.search).get("next") || "/admin";
      router.push(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message || "Could not sign in");
      setBusy(false);
    }
  }

  return (
    <div className="portal-bg relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-10 text-white">
      <div className="portal-grid pointer-events-none absolute inset-0" />
      <div className="orb -left-32 top-[-15%] h-[460px] w-[460px] bg-brand-600/25 blur-[110px]" />
      <div className="orb -right-32 bottom-[-20%] h-[460px] w-[460px] bg-mint-500/15 blur-[120px]" />
      <div className="relative z-10 grid w-full max-w-4xl overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.04] shadow-glass backdrop-blur-2xl lg:grid-cols-2">
        <div className="hidden flex-col justify-between p-10 lg:flex">
          <Logo light />
          <div>
            <div className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-mint-200"><ShieldCheck className="h-3 w-3" /> Owner console</div>
            <h1 className="mt-5 font-display text-[38px] font-extrabold leading-[1.12] tracking-tight">Your network,<br /><span className="gradient-text">under control.</span></h1>
            <p className="mt-4 max-w-sm text-[13px] leading-relaxed text-white/50">Monitor live sessions, issue vouchers, tune plans and keep every access point running smoothly — all from one place.</p>
            <div className="mt-8 space-y-3">
              {[{ icon: Wifi, t: "Live device monitoring" }, { icon: KeyRound, t: "Bulk voucher generation" }, { icon: Zap, t: "Plans, pricing & bandwidth" }].map((x) => (
                <p key={x.t} className="flex items-center gap-3 text-xs text-white/60"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10"><x.icon className="h-3.5 w-3.5 text-brand-300" /></span>{x.t}</p>
              ))}
            </div>
          </div>
          <p className="text-[10px] text-white/30">© {new Date().getFullYear()} Wavly WiFi · Hotspot Manager</p>
        </div>

        <div className="bg-white p-8 text-slate-900 sm:p-10">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Lock className="h-5 w-5" /></div>
          <h2 className="mt-5 font-display text-2xl font-extrabold tracking-tight">Sign in to the console</h2>
          <p className="mt-1.5 text-xs text-slate-500">Enter your administrator password to continue.</p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div>
              <label className="field-label" htmlFor="password">Admin password</label>
              <div className="relative">
                <input id="password" type={show ? "text" : "password"} value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} placeholder="••••••••••" autoFocus
                  className="input pr-11" />
                <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}
            <button disabled={busy || !password} className="btn-primary w-full !py-3">
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Signing in…</> : <>Sign in <ArrowRight className="h-4 w-4" /></>}
            </button>
          </form>

          <div className="mt-6 rounded-xl border border-dashed border-brand-200 bg-brand-50/60 px-4 py-3">
            <p className="text-[11px] font-bold text-brand-800">Demo access</p>
            <p className="mt-1 text-[11px] leading-relaxed text-brand-700/80">Password: <code className="rounded bg-white px-1.5 py-0.5 font-mono font-bold">wavly-demo</code> — change <code className="font-mono text-[10px]">ADMIN_PASSWORD</code> in your environment for production.</p>
          </div>
          <Link href="/" className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-brand-600">← Back to guest portal</Link>
        </div>
      </div>
    </div>
  );
}
