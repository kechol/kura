/**
 * ブラウザ UI のビルドパイプライン（SPEC §8.1）。
 * src/client/index.tsx を dist/ にバンドルし、index.html をコピーする。
 * 成果物はハッシュなしの固定名 index.js / index.css / index.html。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "client", "index.tsx")],
  outdir: dist,
  target: "browser",
  minify: true,
  sourcemap: "none",
  naming: "[dir]/[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

// CSS 成果物を index.css に正規化（Bun が出力しない場合は styles.css をコピー）
const cssArtifact = result.outputs.find((o) => o.path.endsWith(".css"));
const cssPath = join(dist, "index.css");
if (cssArtifact && basename(cssArtifact.path) !== "index.css") {
  renameSync(cssArtifact.path, cssPath);
} else if (!cssArtifact && !existsSync(cssPath)) {
  copyFileSync(join(root, "src", "client", "styles.css"), cssPath);
}

copyFileSync(join(root, "src", "client", "index.html"), join(dist, "index.html"));

for (const name of ["index.html", "index.js", "index.css"]) {
  const path = join(dist, name);
  if (!existsSync(path)) {
    console.error(`ビルド成果物がありません: ${path}`);
    process.exit(1);
  }
  console.log(`dist/${name}  ${(statSync(path).size / 1024).toFixed(1)} KB`);
}
