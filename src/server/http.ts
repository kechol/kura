import { existsSync } from "node:fs";
import { join } from "node:path";
import { embeddedAssets } from "../generated/embedded";
import type { ApiDeps } from "./api";
import { createApiRoutes } from "./api";

/**
 * SPA asset resolution. In development, assets are served from the repo's dist/.
 * In the compiled binary, the M7 build pipeline swaps in the embedded assets.
 */
export type AssetResolver = (path: string) => Promise<Response | null>;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** For compiled binaries: serve from embedded assets (null when nothing is embedded) */
export function embeddedAssetResolver(): AssetResolver | null {
  if (Object.keys(embeddedAssets).length === 0) return null;
  return async (path: string): Promise<Response | null> => {
    const rel = path === "/" ? "/index.html" : path;
    const file = embeddedAssets[rel];
    if (!file) return null;
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(Bun.file(file), {
      headers: { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
    });
  };
}

export function distAssetResolver(distDir: string): AssetResolver {
  return async (path: string): Promise<Response | null> => {
    const rel = path === "/" ? "/index.html" : path;
    if (rel.includes("..")) return null;
    const file = join(distDir, rel);
    if (!existsSync(file)) return null;
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(Bun.file(file), {
      headers: { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
    });
  };
}

const PLACEHOLDER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>kura</title>
<body style="font-family: sans-serif; padding: 2rem;">
<h1>kura browser</h1>
<p>SPA assets not found. Run <code>bun run build</code> and restart the server.</p>
<p>The REST API is available at endpoints such as <code>/api/stats</code>.</p>
</body>`;

export interface ServeOptions extends ApiDeps {
  port: number;
  assets?: AssetResolver;
}

export interface KuraServer {
  port: number;
  url: string;
  stop(): void;
}

/**
 * Browser UI / REST API server (SPEC §8.1).
 * Binds to 127.0.0.1 only; on EADDRINUSE, retries up to 10 times, incrementing the port.
 */
export function startServer(opts: ServeOptions): KuraServer {
  const routes = createApiRoutes(opts);
  const assets =
    opts.assets ??
    embeddedAssetResolver() ??
    distAssetResolver(join(import.meta.dir, "..", "..", "dist"));

  const fetchFallback = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    // SPA fallback: serve index.html when no asset matches (client-side routing)
    const asset = (await assets(url.pathname)) ?? (await assets("/"));
    return (
      asset ??
      new Response(PLACEHOLDER_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    );
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = opts.port + attempt;
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        // biome-ignore lint/suspicious/noExplicitAny: Bun.serve's routes type accepts a wide range of handler shapes
        routes: routes as any,
        fetch: fetchFallback,
      });
      return {
        port: server.port ?? port,
        url: `http://127.0.0.1:${server.port ?? port}`,
        stop: () => server.stop(true),
      };
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      if (!/EADDRINUSE|address already in use/i.test(message)) throw e;
    }
  }
  throw new Error(
    `ports ${opts.port}-${opts.port + 9} are all in use: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
}

/** Open a URL in the OS default browser */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Failing to launch a browser is not fatal
  }
}
