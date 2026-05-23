// deno-lint-ignore-file no-explicit-any
type Context = { ip?: string };

// Env vars:
//   TARGET_URL           — VPS mode: backend Xray server (e.g. http://1.2.3.4:8080)
//   PUBLIC_RELAY_PATH    — VPS mode: public path prefix to strip (default: "")
//   UPSTREAM_PATH_PREFIX — VPS mode: path prefix to add on upstream (default: "")
//   RELAY_KEY            — optional shared secret; clients must send X-Relay-Key header
//   TIMEOUT_MS           — upstream fetch timeout in ms (default: 30000, max: 39000)

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

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "x-target-url",
  "x-relay-key",
  "x-nf-client-connection-ip",
  "x-nf-request-id",
  "x-netlify-original-pathname",
  "x-netlify-deployment-id",
]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

function buildForwardHeaders(request: Request, targetHost: string, clientIp: string): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;
    // Strip all netlify internal headers
    if (lower.startsWith("x-nf-") || lower.startsWith("x-netlify-")) continue;
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
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("x-relay", "netlify-relay");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return headers;
}

function checkAuth(request: Request): boolean {
  const relayKey = Deno.env.get("RELAY_KEY");
  if (!relayKey) return true; // auth disabled
  return request.headers.get("x-relay-key") === relayKey;
}

function isPrivateHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.16.") ||
    hostname.startsWith("192.168.") ||
    hostname.endsWith(".local")
  );
}

async function proxyFetch(
  url: string,
  request: Request,
  targetHost: string,
  clientIp: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers: buildForwardHeaders(request, targetHost, clientIp),
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      signal: controller.signal,
      // @ts-ignore
      duplex: "half",
    });
    clearTimeout(timer);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return new Response("upstream timeout", { status: 504, headers: CORS_HEADERS });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`upstream error: ${msg}`, { status: 502, headers: CORS_HEADERS });
  }
}

export default async (request: Request, context: Context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!checkAuth(request)) {
    return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const clientIp =
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for") ||
    context.ip ||
    "unknown";

  const timeoutMs = Math.min(
    parseInt(Deno.env.get("TIMEOUT_MS") ?? "30000", 10),
    39000
  );

  // --- MODE 1: VPS relay ---
  const targetBase = Deno.env.get("TARGET_URL");
  if (targetBase) {
    const publicPrefix = Deno.env.get("PUBLIC_RELAY_PATH") ?? "";
    const upstreamPrefix = Deno.env.get("UPSTREAM_PATH_PREFIX") ?? "";

    const url = new URL(request.url);
    let pathname = url.pathname;

    // Strip public prefix, prepend upstream prefix
    if (publicPrefix && pathname.startsWith(publicPrefix)) {
      pathname = pathname.slice(publicPrefix.length) || "/";
    }
    pathname = upstreamPrefix + pathname;

    const targetUrl = new URL(pathname + url.search, targetBase);
    const targetHost = new URL(targetBase).host;

    return proxyFetch(targetUrl.toString(), request, targetHost, clientIp, timeoutMs);
  }

  // --- MODE 2: Serverless direct proxy (no VPS) ---
  const targetUrl = request.headers.get("x-target-url");
  if (!targetUrl) {
    return new Response(
      JSON.stringify({
        relay: "netlify-relay",
        mode: "serverless",
        env: {
          TARGET_URL: "unset — serverless mode active",
          RELAY_KEY: Deno.env.get("RELAY_KEY") ? "set" : "unset (auth disabled)",
          TIMEOUT_MS: timeoutMs,
        },
        usage: "Set X-Target-URL header to destination URL",
        example: 'curl -H "X-Target-URL: https://api.ipify.org" https://THIS-SITE.netlify.app/',
      }),
      { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("invalid X-Target-URL", { status: 400, headers: CORS_HEADERS });
  }

  if (!["http:", "https:"].includes(parsedTarget.protocol)) {
    return new Response("only http/https targets allowed", { status: 400, headers: CORS_HEADERS });
  }

  if (isPrivateHost(parsedTarget.hostname)) {
    return new Response("private targets not allowed", { status: 403, headers: CORS_HEADERS });
  }

  return proxyFetch(parsedTarget.toString(), request, parsedTarget.host, clientIp, timeoutMs);
};

