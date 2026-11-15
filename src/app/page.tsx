import Portal from "@/components/Portal";
import { getSnapshot } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const snapshot = await getSnapshot();
  return (
    <Portal
      snapshot={snapshot}
      params={{
        mac: first(params.mac) || first(params.client_mac),
        ap: first(params.ap) || first(params.apname),
        ssid: first(params.ssid),
      }}
    />
  );
}
