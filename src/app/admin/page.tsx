import AdminShell from "@/components/admin/AdminShell";
import OverviewView from "@/components/admin/views/OverviewView";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getSnapshot();
  return <AdminShell initial={snapshot} active="overview"><OverviewView /></AdminShell>;
}
