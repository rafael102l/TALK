const fs = require("fs");
const path = require("path");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const bundleOutput = arg("--bundle-output");
const sourceMap = arg("--sourcemap-output");
const assetsDest = arg("--assets-dest");
const source = path.join(__dirname, "..", "android", "app", "src", "main", "assets", "index.android.bundle.js");

if (!bundleOutput) {
  console.error("missing --bundle-output");
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error("missing prebuilt bundle", source);
  process.exit(1);
}

fs.mkdirSync(path.dirname(bundleOutput), { recursive: true });
fs.copyFileSync(source, bundleOutput);
if (sourceMap) {
  fs.mkdirSync(path.dirname(sourceMap), { recursive: true });
  fs.writeFileSync(sourceMap, JSON.stringify({ version: 3, file: "index.android.bundle", sources: [], mappings: "" }));
}
if (assetsDest) fs.mkdirSync(assetsDest, { recursive: true });
console.log("Copied prebuilt TALK bundle to", bundleOutput);
