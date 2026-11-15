import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminPassword, adminToken } from "@/lib/auth";
import {
  connectWithVoucher, deletePlan, disconnectSession, generateVouchers,
  purchasePlan, revokeVoucher, savePlan, saveSettings, getSnapshot, isLive, setDemoState,
} from "@/lib/store";

export const dynamic = "force-dynamic";

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function done(data: unknown) {
  return NextResponse.json({ ok: true, data, snapshot: await getSnapshot() });
}

export async function POST(req: Request) {
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail("Invalid request body"); }

  try {
    // Demo mode has no database: replay the mutation against the snapshot the
    // browser sent, then hand the updated snapshot back to the caller.
    if (body.demoState && !isLive()) setDemoState(body.demoState);

    switch (body.type) {
      case "login": {
        if (String(body.password ?? "") !== adminPassword()) return fail("Incorrect password. Try again.", 401);
        const res = NextResponse.json({ ok: true, data: { authenticated: true } });
        res.cookies.set(ADMIN_COOKIE, await adminToken(), {
          httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
          path: "/", maxAge: 60 * 60 * 24 * 7,
        });
        return res;
      }
      case "logout": {
        const res = NextResponse.json({ ok: true, data: { authenticated: false } });
        res.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
        return res;
      }
      case "portal.connect": {
        if (!body.tosAccepted) return fail("Please accept the terms of service to connect.");
        if (!String(body.code ?? "").trim()) return fail("Enter your voucher code to continue.");
        const data = await connectWithVoucher({ code: body.code, mac: body.mac, ip: body.ip });
        return done(data);
      }
      case "portal.purchase": {
        if (!body.planId) return fail("Choose a plan first.");
        const data = await purchasePlan({
          planId: body.planId, msisdn: body.msisdn, network: body.network, mac: body.mac, ip: body.ip,
        });
        return done(data);
      }
      case "vouchers.generate": {
        const data = await generateVouchers({
          planId: body.planId, quantity: body.quantity, note: body.note, expiresInDays: body.expiresInDays,
        });
        return done(data);
      }
      case "vouchers.revoke": {
        if (!body.id) return fail("Missing voucher id");
        await revokeVoucher(body.id);
        return done({});
      }
      case "sessions.disconnect": {
        if (!body.id) return fail("Missing session id");
        await disconnectSession(body.id);
        return done({});
      }
      case "plans.save": {
        await savePlan(body.plan ?? {});
        return done({});
      }
      case "plans.delete": {
        if (!body.id) return fail("Missing plan id");
        await deletePlan(body.id);
        return done({});
      }
      case "settings.save": {
        await saveSettings(body.settings ?? {});
        return done({});
      }
      default:
        return fail(`Unknown action: ${String(body.type)}`);
    }
  } catch (err) {
    return fail((err as Error).message || "Something went wrong. Please try again.");
  }
}
