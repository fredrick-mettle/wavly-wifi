import React from "react";

export function WaveMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="wavly-mark" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#8B74FB" />
          <stop offset="1" stopColor="#16AE85" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#wavly-mark)" />
      <path d="M5 16.5c3-4.5 6-4.5 9 0s6 4.5 9 0 6-4.5 9 0 2 3 3 1" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M5 25c3-4.5 6-4.5 9 0s6 4.5 9 0 6-4.5 9 0 2 3 3 1" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

export default function Logo({
  light = false, compact = false, className = "",
}: { light?: boolean; compact?: boolean; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <WaveMark className="h-8 w-8 shrink-0" />
      {!compact && (
        <span className={`font-display text-[19px] font-extrabold tracking-tight ${light ? "text-white" : "text-slate-900"}`}>
          wavly<span className={light ? "text-brand-300" : "text-brand-600"}>.</span>
          <span className={`ml-1 text-[11px] font-bold uppercase tracking-[0.16em] ${light ? "text-white/45" : "text-slate-400"}`}>wifi</span>
        </span>
      )}
    </div>
  );
}
