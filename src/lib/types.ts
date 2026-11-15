export type VoucherStatus = "active" | "used" | "revoked" | "expired";
export type SessionStatus = "active" | "ended" | "expired";

export interface HotspotSettings {
  id: string;
  name: string;
  ssid: string;
  location: string;
  currency: string;
  portal_title: string;
  welcome_message: string;
  tos_text: string;
  max_download_mbps: number;
  max_upload_mbps: number;
  session_timeout_minutes: number;
  is_active: boolean;
  updated_at: string;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  price: number;
  duration_minutes: number;
  data_limit_mb: number | null;
  speed_mbps: number;
  device_limit: number;
  is_active: boolean;
  sort_order: number;
  accent: string;
  created_at: string;
}

export interface Voucher {
  id: string;
  code: string;
  plan_id: string;
  status: VoucherStatus;
  batch_id: string | null;
  note: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
}

export interface Device {
  id: string;
  mac: string;
  vendor: string;
  label: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface Session {
  id: string;
  voucher_id: string | null;
  device_id: string;
  plan_id: string;
  started_at: string;
  expires_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  bytes_used: number;
  ip: string | null;
}

export interface ActivityEvent {
  id: string;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface UsagePoint {
  date: string;
  label: string;
  connections: number;
  revenue: number;
  gb: number;
}

export interface Snapshot {
  mode: "live" | "demo";
  hotspot: HotspotSettings;
  plans: Plan[];
  vouchers: Voucher[];
  devices: Device[];
  sessions: Session[];
  events: ActivityEvent[];
  usage: UsagePoint[];
  generated_at: string;
}

export interface ActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  snapshot?: Snapshot;
}
