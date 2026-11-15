import AdminShell from "@/components/admin/AdminShell";
import SettingsView from "@/components/admin/views/SettingsView";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getSnapshot();
  return <AdminShell initial={snapshot} active="settings"><SettingsView /></AdminShell>;
}
