"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronLeft, Clock, CreditCard,
  Headphones, KeyRound, Lock, MonitorSmartphone, ShieldCheck, Signal, Smartphone,
  Sparkles, Ticket, Wifi, X, Zap, Loader2, Copy, Info,
} from "lucide-react";
import Logo from "@/components/Logo";
import { sendAction } from "@/lib/client";
import { currencySymbol, dataLabel, durationLabel, maskMac, money, timeLeft } from "@/lib/format";
import type { Plan, Snapshot } from "@/lib/types";

const ACCENTS: Record<string, { bar: string; chip: string; glow: string }> = {
  blue: { bar: "from-sky-400 to-blue-600", chip: "bg-sky-400/15 text-sky-200", glow: "rgba(56,189,248,.28)" },
  violet: { bar: "from-brand-400 to-brand-600", chip: "bg-brand-400/15 text-brand-200", glow: "rgba(139,116,251,.32)" },
  teal: { bar: "from-mint-300 to-mint-600", chip: "bg-mint-300/15 text-mint-200", glow: "rgba(45,212,191,.28)" },
  amber: { bar: "from-sand-300 to-sand-500", chip: "bg-sand-300/15 text-sand-200", glow: "rgba(251,146,60,.28)" },
};

const NETWORKS = [
  { id: "MTN MoMo", label: "MTN MoMo", tone: "bg-[#FFCC00] text-black" },
  { id: "Telecel Cash", label: "Telecel Cash", tone: "bg-[#E60000] text-white" },
  { id: "AT Money", label: "AT Money", tone: "bg-[#1B75BB] text-white" },
];

type Tab = "voucher" | "buy";
type SuccessData = {
  plan: Plan;
  session: { id: string; expires_at: string | null; ip: string | null };
  device: { vendor: string; mac: string };
  voucher: { code: string };
  purchasedCode?: string;
};

export default function Portal({
  snapshot, params,
}: {
  snapshot: Snapshot;
  params: { mac: string; ap: string; ssid: string };
}) {
  const { hotspot, plans } = snapshot;
  const activePlans = useMemo(() => plans.filter((p) => p.is_active), [plans]);
  const liveCount = useMemo(() => snapshot.sessions.filter((s) => s.status === "active").length, [snapshot.sessions]);

  const mac = params.mac || "A4:83:E7:2B:19:4C";
  const [tab, setTab] = useState<Tab>("voucher");
  const [buyStep, setBuyStep] = useState<"select" | "checkout">("select");
  const [selectedPlan, setSelectedPlan] = useState<string>(activePlans[1]?.id ?? activePlans[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [tos, setTos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<SuccessData | null>(null);
  const [showTos, setShowTos] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [network, setNetwork] = useState(NETWORKS[0].id);
  const [msisdn, setMsisdn] = useState("");
  const [copied, setCopied] = useState(false);
  const [demoState, setDemoState] = useState<Snapshot | null>(snapshot.mode === "demo" ? snapshot : null);

  async function submit() {
    setError("");
    if (!tos) { setError("Please accept the terms of service to continue."); return; }
    if (tab === "voucher" && !code.trim()) { setError("Enter your voucher code to continue."); return; }
    if (tab === "buy") {
      if (buyStep === "select") {
        if (!selectedPlan) { setError("Choose a plan to continue."); return; }
        setBuyStep("checkout");
        return;
      }
      if (msisdn.trim() && !/^0\d{9}$/.test(msisdn.replace(/\s/g, ""))) {
        setError("Enter a valid 10-digit Ghanaian mobile number, or leave it blank for the demo.");
        return;
      }
    }
    setBusy(true);
    try {
      const payload = tab === "voucher"
        ? { type: "portal.connect", code, mac, tosAccepted: true }
        : { type: "portal.purchase", planId: selectedPlan, mac, network, msisdn, tosAccepted: true };
      const res = await sendAction(payload, demoState);
      if (res.snapshot) setDemoState(res.snapshot);
      setSuccess(res.data as SuccessData);
    } catch (err) {
      setError((err as Error).message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setSuccess(null); setError(""); setCode(""); setBuyStep("select"); setTos(false); setMsisdn("");
  }

  const chosenPlan = activePlans.find((p) => p.id === selectedPlan);

  return (
    <div className="portal-bg relative min-h-screen overflow-hidden text-white">
      <div className="portal-grid pointer-events-none absolute inset-0" />
      <div className="orb -left-40 top-[-10%] h-[520px] w-[520px] bg-brand-600/25 blur-[110px] animate-drift" />
      <div className="orb right-[-12%] top-[18%] h-[420px] w-[420px] bg-mint-500/15 blur-[120px] animate-floaty" />
      <div className="orb bottom-[-25%] left-[35%] h-[560px] w-[560px] bg-indigo-700/20 blur-[130px]" />

      {/* Header */}
      <header className="relative z-10 mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-5 py-6 lg:px-10">
        <Logo light />
        <div className="flex items-center gap-2.5">
          <span className="glass hidden items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold text-white/80 sm:inline-flex">
            <span className="relative flex h-2 w-2 text-mint-300 ring-pulse"><span className="absolute inline-flex h-2 w-2 rounded-full bg-mint-300" /></span>
            {params.ssid || hotspot.ssid}
          </span>
          <Link href="/admin" className="glass inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[11px] font-bold text-white/85 transition hover:bg-white/15">
            Admin console <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid max-w-[1280px] gap-12 px-5 pb-24 pt-6 lg:grid-cols-[1fr_452px] lg:gap-16 lg:px-10 lg:pt-14">
        {/* Left: hero */}
        <div className="animate-fade-up">
          <div className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/70">
            <Sparkles className="h-3 w-3 text-mint-300" /> {hotspot.name} · Guest network
          </div>

          <h1 className="mt-6 font-display text-[44px] font-extrabold leading-[1.05] tracking-[-0.035em] sm:text-[58px] lg:text-[64px]">
            {hotspot.portal_title.split(" ").slice(0, -1).join(" ") || "Welcome to"}{" "}
            <span className="gradient-text block">{hotspot.portal_title.split(" ").slice(-1)[0]}</span>
          </h1>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-white/55">{hotspot.welcome_message}</p>

          <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
            {[
              { icon: Zap, label: "Instant access", value: "< 10 sec" },
              { icon: ShieldCheck, label: "Secure network", value: "WPA3" },
              { icon: Signal, label: "Devices online", value: String(liveCount) },
            ].map((x) => (
              <div key={x.label} className="glass rounded-2xl px-3.5 py-3.5">
                <x.icon className="h-4 w-4 text-mint-300" />
                <p className="mt-3 font-display text-lg font-bold tabular">{x.value}</p>
                <p className="mt-0.5 text-[10px] font-medium text-white/45">{x.label}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 max-w-lg space-y-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/35">How it works</p>
            {[
              { n: "01", icon: Ticket, title: "Get a voucher", text: "Buy a plan with Mobile Money or grab a printed code at the front desk." },
              { n: "02", icon: KeyRound, title: "Enter your code", text: "Type it below, accept the terms, and hit connect. No password needed." },
              { n: "03", icon: Wifi, title: "You're online", text: `Enjoy up to ${hotspot.max_download_mbps} Mbps for the length of your plan.` },
            ].map((step) => (
              <div key={step.n} className="flex items-start gap-4">
                <div className="glass flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-brand-200">{step.n}</div>
                <div className="pt-0.5">
                  <p className="flex items-center gap-2 text-[13px] font-bold text-white/90"><step.icon className="h-3.5 w-3.5 text-white/45" />{step.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/45">{step.text}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="glass mt-10 flex max-w-lg flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl px-4 py-3.5 text-[11px] text-white/55">
            <span className="inline-flex items-center gap-2"><MonitorSmartphone className="h-3.5 w-3.5 text-brand-300" /> Detected device</span>
            <span className="font-mono font-semibold text-white/80">{maskMac(mac)}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-mint-300"><span className="h-1.5 w-1.5 rounded-full bg-mint-300" /> Ready to connect</span>
          </div>
        </div>

        {/* Right: connect card */}
        <div className="relative lg:pt-2">
          <div className="pointer-events-none absolute -inset-3 rounded-[36px] bg-gradient-to-br from-brand-500/20 via-transparent to-mint-500/15 blur-2xl" />
          <div className="glass relative rounded-[28px] p-5 shadow-glass sm:p-7 animate-[fadeUp_.6s_ease-out]">
            {!success ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-mint-300">Captive portal</p>
                    <h2 className="mt-1 font-display text-[22px] font-extrabold tracking-tight">Get connected</h2>
                  </div>
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10"><Wifi className="h-5 w-5 text-white" /></div>
                </div>

                {/* Tabs */}
                <div className="mt-6 flex rounded-xl bg-black/25 p-1">
                  {(["voucher", "buy"] as Tab[]).map((t) => (
                    <button key={t} onClick={() => { setTab(t); setError(""); setBuyStep("select"); }}
                      className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-bold transition ${tab === t ? "bg-white text-ink shadow" : "text-white/55 hover:text-white"}`}>
                      {t === "voucher" ? <KeyRound className="h-3.5 w-3.5" /> : <CreditCard className="h-3.5 w-3.5" />}
                      {t === "voucher" ? "I have a voucher" : "Buy a plan"}
                    </button>
                  ))}
                </div>

                <div className="mt-6 min-h-[268px]">
                  {tab === "voucher" ? (
                    <div className="animate-[fadeUp_.3s_ease-out]">
                      <label className="mb-2 block text-[11px] font-bold uppercase tracking-[0.12em] text-white/50" htmlFor="voucher">Voucher code</label>
                      <div className="relative">
                        <Ticket className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <input id="voucher" value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }}
                          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                          placeholder="WAVLY-XXXX-XXXX" spellCheck={false} autoComplete="off"
                          className="w-full rounded-xl border border-white/15 bg-black/25 py-3.5 pl-11 pr-4 font-mono text-[15px] font-bold tracking-[0.12em] text-white outline-none transition placeholder:font-normal placeholder:tracking-normal placeholder:text-white/25 focus:border-brand-400 focus:ring-4 focus:ring-brand-500/20" />
                      </div>
                      <button onClick={() => { setCode("WAVLY-DEMO-2026"); setError(""); }}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-dashed border-mint-300/40 bg-mint-300/[0.07] px-3 py-2 text-[11px] font-semibold text-mint-200 transition hover:bg-mint-300/15">
                        <Sparkles className="h-3 w-3" /> Just exploring? Use demo voucher <span className="font-mono">WAVLY-DEMO-2026</span>
                      </button>

                      <div className="mt-6 space-y-2.5 rounded-xl border border-white/10 bg-white/[0.035] p-4">
                        {[
                          { icon: Clock, text: "Your time starts the moment you connect" },
                          { icon: Lock, text: "One voucher works on one device" },
                          { icon: Headphones, text: "Need help? Ask at the front desk" },
                        ].map((x) => (
                          <p key={x.text} className="flex items-center gap-2.5 text-[11px] text-white/50"><x.icon className="h-3.5 w-3.5 shrink-0 text-white/30" />{x.text}</p>
                        ))}
                      </div>
                    </div>
                  ) : buyStep === "select" ? (
                    <div className="animate-[fadeUp_.3s_ease-out]">
                      <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-white/50">Choose your pass</p>
                      <div className="scroll-thin max-h-[250px] space-y-2 overflow-y-auto pr-1">
                        {activePlans.map((p) => {
                          const acc = ACCENTS[p.accent] ?? ACCENTS.violet;
                          const selected = selectedPlan === p.id;
                          return (
                            <button key={p.id} onClick={() => { setSelectedPlan(p.id); setError(""); }}
                              className={`relative flex w-full items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition ${selected ? "border-brand-400 bg-brand-400/10 ring-2 ring-brand-500/30" : "border-white/10 bg-white/[0.035] hover:border-white/25"}`}>
                              <span className={`h-9 w-1 shrink-0 rounded-full bg-gradient-to-b ${acc.bar}`} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="text-[13px] font-bold text-white">{p.name}</span>
                                  {p.sort_order === 2 && <span className={`chip ${acc.chip} !px-2 !py-0.5 !text-[9px]`}>POPULAR</span>}
                                </span>
                                <span className="mt-0.5 block truncate text-[10px] text-white/45">
                                  {durationLabel(p.duration_minutes)} · {dataLabel(p.data_limit_mb)} · {p.speed_mbps} Mbps
                                </span>
                              </span>
                              <span className="shrink-0 text-right">
                                <span className="block font-display text-[15px] font-extrabold text-white">{money(p.price, hotspot.currency)}</span>
                                <span className="block text-[9px] text-white/35">one-time</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-3 flex items-center gap-1.5 text-[10px] text-white/35"><Info className="h-3 w-3" /> Demo checkout — no real payment is taken.</p>
                    </div>
                  ) : (
                    <div className="animate-[fadeUp_.3s_ease-out]">
                      <button onClick={() => setBuyStep("select")} className="mb-4 inline-flex items-center gap-1 text-[11px] font-semibold text-white/55 hover:text-white"><ChevronLeft className="h-3.5 w-3.5" /> Change plan</button>
                      {chosenPlan && (
                        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.045] p-3.5">
                          <div>
                            <p className="text-[13px] font-bold">{chosenPlan.name}</p>
                            <p className="mt-0.5 text-[10px] text-white/45">{durationLabel(chosenPlan.duration_minutes)} · {dataLabel(chosenPlan.data_limit_mb)}</p>
                          </div>
                          <p className="font-display text-lg font-extrabold">{money(chosenPlan.price, hotspot.currency)}</p>
                        </div>
                      )}
                      <p className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-[0.12em] text-white/50">Pay with Mobile Money</p>
                      <div className="grid grid-cols-3 gap-2">
                        {NETWORKS.map((n) => (
                          <button key={n.id} onClick={() => setNetwork(n.id)}
                            className={`rounded-xl border p-2 text-center text-[10px] font-bold transition ${network === n.id ? "border-brand-400 bg-brand-400/10 text-white" : "border-white/10 bg-white/[0.035] text-white/55 hover:border-white/25"}`}>
                            <span className={`mx-auto mb-1.5 flex h-5 w-5 items-center justify-center rounded-md ${n.tone}`}><Smartphone className="h-3 w-3" /></span>
                            {n.label.split(" ")[0]}
                          </button>
                        ))}
                      </div>
                      <label className="mb-2 mt-5 block text-[11px] font-bold uppercase tracking-[0.12em] text-white/50" htmlFor="msisdn">Mobile number (optional)</label>
                      <input id="msisdn" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} placeholder="024 000 0000" inputMode="tel"
                        className="w-full rounded-xl border border-white/15 bg-black/25 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-brand-400 focus:ring-4 focus:ring-brand-500/20" />
                      <p className="mt-3 flex items-center gap-1.5 text-[10px] text-mint-200/70"><ShieldCheck className="h-3 w-3" /> Demo checkout — a voucher is issued instantly, no charge is made.</p>
                    </div>
                  )}
                </div>

                {/* Terms */}
                <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl bg-black/20 px-3.5 py-3">
                  <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition ${tos ? "border-brand-400 bg-brand-500" : "border-white/30 bg-white/5"}`}>
                    {tos && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                  </span>
                  <input type="checkbox" checked={tos} onChange={(e) => { setTos(e.target.checked); setError(""); }} className="sr-only" />
                  <span className="text-[11px] leading-relaxed text-white/55">
                    I agree to the{" "}
                    <button type="button" onClick={(e) => { e.preventDefault(); setShowTos(true); }} className="font-bold text-brand-300 underline underline-offset-2 hover:text-brand-200">Terms of Service</button>
                    {" "}and acceptable use policy.
                  </span>
                </label>

                {error && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-[11px] font-medium text-rose-200">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
                  </div>
                )}

                <button onClick={submit} disabled={busy}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 py-3.5 text-sm font-bold text-white shadow-glow transition hover:from-brand-400 hover:to-brand-500 active:scale-[.99] disabled:opacity-60">
                  {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</> : (
                    <>
                      {tab === "buy" && buyStep === "select" ? "Continue to checkout" : tab === "buy" ? "Get voucher & connect" : "Connect to WiFi"}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>

                <p className="mt-4 text-center text-[10px] text-white/30">
                  {tab === "voucher" ? (
                    <>No voucher? <button onClick={() => { setTab("buy"); setError(""); }} className="font-bold text-white/60 underline underline-offset-2 hover:text-white">Buy a plan instead</button></>
                  ) : (
                    <>Already have a code? <button onClick={() => { setTab("voucher"); setError(""); }} className="font-bold text-white/60 underline underline-offset-2 hover:text-white">Enter it here</button></>
                  )}
                </p>
              </>
            ) : (
              /* Success */
              <div className="animate-pop py-2 text-center">
                <div className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-mint-400/15">
                  <div className="absolute inset-0 rounded-full border border-mint-300/30 ring-pulse text-mint-300" />
                  <CheckCircle2 className="h-10 w-10 text-mint-300" strokeWidth={1.8} />
                </div>
                <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-mint-300">Connection established</p>
                <h2 className="mt-2 font-display text-[26px] font-extrabold tracking-tight">You&apos;re online!</h2>
                <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-white/50">You can now close this page and browse the internet. Keep your voucher handy in case you get disconnected.</p>

                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-left">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <span className="text-[11px] text-white/45">Your plan</span>
                    <span className="text-[13px] font-bold">{success.plan.name}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-3">
                    <div><p className="text-[10px] text-white/40">Time allowance</p><p className="mt-1 text-[13px] font-bold">{durationLabel(success.plan.duration_minutes)}</p></div>
                    <div><p className="text-[10px] text-white/40">Data allowance</p><p className="mt-1 text-[13px] font-bold">{dataLabel(success.plan.data_limit_mb)}</p></div>
                    <div><p className="text-[10px] text-white/40">Expires</p><p className="mt-1 text-[13px] font-bold text-mint-300">{timeLeft(success.session.expires_at)}</p></div>
                    <div><p className="text-[10px] text-white/40">Speed up to</p><p className="mt-1 text-[13px] font-bold">{success.plan.speed_mbps} Mbps</p></div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-white/15 bg-white/[0.035] px-3.5 py-3">
                  <div className="text-left">
                    <p className="text-[10px] text-white/40">Voucher used</p>
                    <p className="mt-0.5 font-mono text-[12px] font-bold tracking-wider">{success.purchasedCode ?? success.voucher.code}</p>
                  </div>
                  <button onClick={async () => { try { await navigator.clipboard.writeText(success.purchasedCode ?? success.voucher.code); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1600); }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-[10px] font-bold hover:bg-white/20">
                    {copied ? <Check className="h-3 w-3 text-mint-300" /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy"}
                  </button>
                </div>

                <p className="mt-4 text-[10px] text-white/35">{success.device.vendor} · {maskMac(success.device.mac)} · {params.ssid || hotspot.ssid}</p>
                <button onClick={reset} className="mt-5 w-full rounded-xl border border-white/15 bg-white/10 py-3 text-xs font-bold text-white transition hover:bg-white/20">Connect another device</button>
              </div>
            )}
          </div>

          <button onClick={() => setShowHelp(true)} className="mt-5 flex w-full items-center justify-center gap-2 text-[11px] font-semibold text-white/40 transition hover:text-white/80">
            <Headphones className="h-3.5 w-3.5" /> Need help connecting?
          </button>
        </div>
      </main>

      <footer className="relative z-10 mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-6 text-[10px] text-white/30 lg:px-10">
        <p>© {new Date().getFullYear()} Wavly WiFi · {hotspot.location}</p>
        <div className="flex items-center gap-4">
          <button onClick={() => setShowTos(true)} className="hover:text-white/70">Terms</button>
          <button onClick={() => setShowHelp(true)} className="hover:text-white/70">Help</button>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-bold ${snapshot.mode === "live" ? "bg-mint-300/10 text-mint-300" : "bg-white/5 text-white/40"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${snapshot.mode === "live" ? "bg-mint-300" : "bg-white/40"}`} />
            {snapshot.mode === "live" ? "Live network" : "Demo mode"}
          </span>
        </div>
      </footer>

      {/* Terms modal */}
      {showTos && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowTos(false)} />
          <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#121829] shadow-2xl animate-pop">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <h3 className="font-display text-base font-bold">Terms of Service & Acceptable Use</h3>
              <button onClick={() => setShowTos(false)} className="text-white/50 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <div className="scroll-thin max-h-[60vh] overflow-y-auto px-6 py-5 text-[12px] leading-relaxed text-white/60">
              <p className="whitespace-pre-line">{hotspot.tos_text}</p>
              <div className="mt-5 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <p><strong className="text-white/80">Fair use.</strong> Bandwidth may be shaped during busy periods to keep the network usable for everyone.</p>
                <p><strong className="text-white/80">Session records.</strong> We store your device MAC address, session start/end times and data volume for network operations.</p>
                <p><strong className="text-white/80">Support.</strong> For help, contact the front desk or email support@wavly.wifi.</p>
              </div>
            </div>
            <div className="border-t border-white/10 px-6 py-4">
              <button onClick={() => { setTos(true); setShowTos(false); }} className="w-full rounded-xl bg-brand-600 py-3 text-xs font-bold hover:bg-brand-500">I accept these terms</button>
            </div>
          </div>
        </div>
      )}

      {/* Help modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowHelp(false)} />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-[#121829] p-6 shadow-2xl animate-pop">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold">Need a hand?</h3>
              <button onClick={() => setShowHelp(false)} className="text-white/50 hover:text-white"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-5 space-y-3 text-[12px] text-white/60">
              <p className="flex items-start gap-3"><Ticket className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" /><span><strong className="text-white/85">Where do I get a code?</strong><br />Buy one in the &ldquo;Buy a plan&rdquo; tab, or ask at the front desk / your host.</span></p>
              <p className="flex items-start gap-3"><KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" /><span><strong className="text-white/85">My code doesn&apos;t work</strong><br />Check for typos. Each code works once, on one device. Expired or revoked codes can&apos;t be reused.</span></p>
              <p className="flex items-start gap-3"><Headphones className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" /><span><strong className="text-white/85">Still stuck?</strong><br />Reach the front desk or email <span className="font-semibold text-white/80">support@wavly.wifi</span>.</span></p>
            </div>
            <button onClick={() => setShowHelp(false)} className="mt-6 w-full rounded-xl bg-white/10 py-3 text-xs font-bold hover:bg-white/20">Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}
