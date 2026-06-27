/**
 * Server-side proxy for anchor (testanchor.stellar.org) requests.
 * Avoids browser CORS preflight failures when calling the anchor from localhost.
 * All SEP-10 and SEP-24 calls go through here.
 */

import { NextRequest, NextResponse } from "next/server";

const ANCHOR_BASE = "https://testanchor.stellar.org";

function buildAnchorUrl(slug: string[], search: string): string {
  return `${ANCHOR_BASE}/${slug.join("/")}${search}`;
}

function copyHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = request.headers.get("Authorization");
  if (auth) headers["Authorization"] = auth;
  const ct = request.headers.get("Content-Type");
  if (ct) headers["Content-Type"] = ct;
  return headers;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const url = buildAnchorUrl(slug, request.nextUrl.search);
  const headers = copyHeaders(request);

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    return NextResponse.json(
      { error: `Upstream GET failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const url = buildAnchorUrl(slug, "");

  // Forward Authorization + Content-Type (includes multipart boundary if present).
  const headers: Record<string, string> = {};
  const auth = request.headers.get("Authorization");
  if (auth) headers["Authorization"] = auth;
  const ct = request.headers.get("Content-Type");
  if (ct) headers["Content-Type"] = ct;

  // Pipe the raw body stream so multipart/form-data boundaries are preserved.
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: request.body,
      // Required to stream the body in Node.js fetch
      duplex: "half",
    } as RequestInit);
  } catch (e) {
    return NextResponse.json(
      { error: `Upstream POST failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}
