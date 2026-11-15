import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_COOKIE, adminToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === "/admin/login") return NextResponse.next();
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (token && token === (await adminToken())) return NextResponse.next();
  const url = new URL("/admin/login", req.url);
  if (req.nextUrl.pathname !== "/admin") url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/admin/:path*"] };
