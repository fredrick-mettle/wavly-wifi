import type { Snapshot } from "./types";

export async function getState(): Promise<Snapshot> {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load network state");
  return res.json();
}

export interface ActionResponse {
  ok: boolean;
  data?: any;
  snapshot?: Snapshot;
  error?: string;
}

export async function sendAction(
  payload: Record<string, unknown>,
  demoState?: Snapshot | null,
): Promise<ActionResponse> {
  const body = demoState ? { ...payload, demoState } : payload;
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: ActionResponse = await res.json().catch(() => ({ ok: false, error: "Request failed" }));
  if (!res.ok || !json.ok) throw new Error(json.error || "Request failed");
  return json;
}
