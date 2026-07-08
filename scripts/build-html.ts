/**
 * Browser UI build pipeline (SPEC §8.1).
 * Bundles src/client/index.tsx into dist/ and copies index.html.
 * Artifacts use fixed, hash-free names: index.js / index.css / index.html.
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

// Normalize the CSS artifact to index.css (copy styles.css when Bun emits none)
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
    console.error(`build artifact missing: ${path}`);
    process.exit(1);
  }
  console.log(`dist/${name}  ${(statSync(path).size / 1024).toFixed(1)} KB`);
}
