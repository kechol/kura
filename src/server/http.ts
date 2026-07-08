import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApiDeps } from "./api";
import { createApiRoutes } from "./api";

/**
 * SPA アセットの解決。開発時はリポジトリの dist/ から配信する。
 * コンパイル済みバイナリでは M7 のビルドパイプラインが埋め込みアセットに差し替える。
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
<p>SPA アセットが見つかりません。<code>bun run build</code> を実行してから再起動してください。</p>
<p>REST API は <code>/api/stats</code> などで利用できます。</p>
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
 * ブラウザ UI / REST API サーバー（SPEC §8.1）。
 * 127.0.0.1 のみにバインドし、EADDRINUSE 時はポートを +1 しながら最大 10 回リトライする。
 */
export function startServer(opts: ServeOptions): KuraServer {
  const routes = createApiRoutes(opts);
  const assets = opts.assets ?? distAssetResolver(join(import.meta.dir, "..", "..", "dist"));

  const fetchFallback = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    // SPA フォールバック: アセットが無ければ index.html（クライアントルーティング）
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
        // biome-ignore lint/suspicious/noExplicitAny: Bun.serve の routes 型はハンドラ形状が広い
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
    `ポート ${opts.port}〜${opts.port + 9} がすべて使用中です: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
}

/** OS 既定のブラウザで URL を開く */
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
    // ブラウザ起動失敗は致命的ではない
  }
}
