export function currencySymbol(code: string): string {
  const map: Record<string, string> = { GHS: "GH₵", USD: "$", EUR: "€", GBP: "£", NGN: "₦", KES: "KSh" };
  return map[code] ?? `${code} `;
}

export function money(value: number, code = "GHS"): string {
  const sym = currencySymbol(code);
  const n = Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${n}`;
}

export function compactMoney(value: number, code = "GHS"): string {
  const sym = currencySymbol(code);
  if (Math.abs(value) >= 1000) return `${sym}${(value / 1000).toFixed(1)}k`;
  return `${sym}${Math.round(value)}`;
}

export function durationLabel(minutes: number): string {
  if (minutes <= 0) return "Unlimited";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const h = minutes / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} hr${h === 1 ? "" : "s"}`;
  }
  const d = minutes / 1440;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? "" : "s"}`;
}

export function dataLabel(mb: number | null): string {
  if (mb === null || mb === undefined) return "Unlimited";
  if (mb >= 1024) return `${mb / 1024} GB`;
  return `${mb} MB`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + ", " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short" });
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return shortDate(iso);
}

export function timeLeft(iso: string | null): string {
  if (!iso) return "No limit";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m left`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h left`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
}

export function maskMac(mac: string): string {
  const parts = mac.split(":");
  if (parts.length < 4) return mac;
  return `${parts[0]}:${parts[1]}:**:**:${parts[4]}:${parts[5]}`;
}
