"use client";

import React, { createContext, useCallback, useContext, useState } from "react";
import { getState, sendAction } from "@/lib/client";
import type { Snapshot } from "@/lib/types";

export type Toast = { id: number; kind: "ok" | "err"; text: string };

interface AdminCtx {
  snap: Snapshot;
  busy: boolean;
  toast: Toast | null;
  notify: (text: string, kind?: "ok" | "err") => void;
  refresh: () => Promise<void>;
  run: (payload: Record<string, unknown>, successMsg?: string) => Promise<any>;
}

const Ctx = createContext<AdminCtx | null>(null);

export function AdminProvider({ initial, children }: { initial: Snapshot; children: React.ReactNode }) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const t = { id: Date.now(), kind, text };
    setToast(t);
    setTimeout(() => setToast((cur) => (cur?.id === t.id ? null : cur)), 4200);
  }, []);

  const refresh = useCallback(async () => {
    // In demo mode the browser is the source of truth — refetching a fresh
    // seed from another serverless instance would discard local changes.
    if (snap.mode === "demo") return;
    try { setSnap(await getState()); } catch { /* keep current state */ }
  }, [snap.mode]);

  const run = useCallback(async (payload: Record<string, unknown>, successMsg?: string) => {
    setBusy(true);
    try {
      const result = await sendAction(payload, snap.mode === "demo" ? snap : null);
      if (result.snapshot) setSnap(result.snapshot);
      else await refresh();
      if (successMsg) notify(successMsg, "ok");
      return result.data ?? {};
    } catch (err) {
      notify((err as Error).message || "Something went wrong", "err");
      return null;
    } finally {
      setBusy(false);
    }
  }, [snap, refresh, notify]);

  return <Ctx.Provider value={{ snap, busy, toast, notify, refresh, run }}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAdmin must be used inside AdminProvider");
  return ctx;
}
