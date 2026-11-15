import AdminShell from "@/components/admin/AdminShell";
import PlansView from "@/components/admin/views/PlansView";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getSnapshot();
  return <AdminShell initial={snapshot} active="plans"><PlansView /></AdminShell>;
}
