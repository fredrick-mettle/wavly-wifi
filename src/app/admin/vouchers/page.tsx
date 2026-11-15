import AdminShell from "@/components/admin/AdminShell";
import VouchersView from "@/components/admin/views/VouchersView";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await getSnapshot();
  return <AdminShell initial={snapshot} active="vouchers"><VouchersView /></AdminShell>;
}
