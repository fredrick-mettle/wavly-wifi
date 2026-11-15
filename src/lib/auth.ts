export const ADMIN_COOKIE = "wavly_admin";

export function adminPassword(): string {
  return process.env.ADMIN_PASSWORD || "wavly-demo";
}

export async function adminToken(): Promise<string> {
  const secret = process.env.ADMIN_SESSION_SECRET || "wavly-local-session-secret";
  const raw = new TextEncoder().encode(`${adminPassword()}::${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
