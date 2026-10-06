const fs = require("fs");
const path = require("path");
const { loadConfig, runBuild } = require("metro");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const workspaceRoot = path.resolve(projectRoot, "../..");
  const outDir = path.join(projectRoot, "android", "app", "src", "main", "assets");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "index.android.bundle.js");
  const config = await loadConfig({ cwd: projectRoot });
  await runBuild(config, {
    platform: "android",
    entry: path.join(workspaceRoot, "node_modules", "expo-router", "entry.js"),
    out,
    dev: false,
    minify: false,
    sourceMap: false,
  });
  console.log("Wrote", out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
