import AdminShell from "@/components/admin/AdminShell";
import SessionsView from "@/components/admin/views/SessionsView";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getSnapshot();
  return <AdminShell initial={snapshot} active="sessions"><SessionsView /></AdminShell>;
}
