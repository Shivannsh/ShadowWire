/**
 * Server-side proxy for the testanchor reference server.
 * anchor-reference-server-testanchor.stellar.org runs the business logic that
 * backs the SEP-24 interactive UI. Proxying from here avoids browser CORS.
 */

import { NextRequest, NextResponse } from "next/server";

const REF_SERVER_BASE = "https://anchor-reference-server-testanchor.stellar.org";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const url = `${REF_SERVER_BASE}/${slug.join("/")}${request.nextUrl.search}`;
  const auth = request.headers.get("Authorization");
  const headers: Record<string, string> = {};
  if (auth) headers["Authorization"] = auth;

  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    return NextResponse.json({ error: `Upstream GET failed: ${(e as Error).message}` }, { status: 502 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const url = `${REF_SERVER_BASE}/${slug.join("/")}`;
  const auth = request.headers.get("Authorization");
  const ct = request.headers.get("Content-Type");
  const headers: Record<string, string> = {};
  if (auth) headers["Authorization"] = auth;
  if (ct) headers["Content-Type"] = ct;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: request.body,
      duplex: "half",
    } as RequestInit);
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    return NextResponse.json({ error: `Upstream POST failed: ${(e as Error).message}` }, { status: 502 });
  }
}
