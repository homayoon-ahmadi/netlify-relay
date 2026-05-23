import type { Config, Context } from "@netlify/edge-functions";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// Headers not forwarded to upstream
const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "x-target-url",
  "x-nf-client-connection-ip",
]);

function buildForwardHeaders(request: Request, targetHost: string, clientIp: string): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;
    headers.set(key, value);
  }
  headers.set("host", targetHost);
  headers.set("x-forwarded-for", clientIp);
  headers.set("x-forwarded-proto", "https");
  return headers;
}

function buildResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set("x-relay", "netlify-relay");
  // Allow CORS so browser clients can test directly
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "*");
  headers.set("access-control-allow-headers", "*");
  return headers;
}

export default async (request: Request, context: Context) => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "*",
        "access-control-allow-headers": "*",
      },
    });
  }

  const clientIp =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-nf-client-connection-ip") ||
    context.ip ||
    "unknown";

  // --- MODE 1: VPS relay (TARGET_URL env set) ---
  const targetBase = Deno.env.get("TARGET_URL");
  if (targetBase) {
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, targetBase);
    const targetHost = new URL(targetBase).host;

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: buildForwardHeaders(request, targetHost, clientIp),
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        // @ts-ignore
        duplex: "half",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`upstream error: ${msg}`, { status: 502 });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream),
    });
  }

  // --- MODE 2: Serverless direct proxy (no VPS) ---
  // Target specified via X-Target-URL header
  const targetUrl = request.headers.get("x-target-url");
  if (!targetUrl) {
    return new Response(
      JSON.stringify({
        relay: "netlify-relay",
        mode: "serverless",
        usage: "Set X-Target-URL header to the destination URL",
        example: 'curl -H "X-Target-URL: https://api.ipify.org" https://THIS-SITE.netlify.app/',
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("invalid X-Target-URL", { status: 400 });
  }

  // Block private/loopback targets
  const hostname = parsedTarget.hostname;
  if (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname === "0.0.0.0"
  ) {
    return new Response("private targets not allowed", { status: 403 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsedTarget.toString(), {
      method: request.method,
      headers: buildForwardHeaders(request, parsedTarget.host, clientIp),
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      // @ts-ignore
      duplex: "half",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`fetch failed: ${msg}`, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(upstream),
  });
};

export const config: Config = {
  path: "/*",
};
