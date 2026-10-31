const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { dirname, resolve } = require("path");
const { execFileSync } = require("child_process");

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./data/talk.db";
}

const url = process.env.DATABASE_URL;
const provider = url.startsWith("file:") ? "sqlite" : "postgresql";

if (provider === "sqlite") {
  const filePath = url.replace(/^file:/, "");
  const abs = resolve(process.cwd(), filePath);
  mkdirSync(dirname(abs), { recursive: true });
}

const schemaPath = resolve(__dirname, "../prisma/schema.prisma");
const runtimeSchema = resolve(__dirname, "../prisma/schema.runtime.prisma");
const schema = readFileSync(schemaPath, "utf8").replace(
  /provider\s*=\s*"(sqlite|postgresql)"/,
  `provider = "${provider}"`,
);
writeFileSync(runtimeSchema, schema);

console.log(`[ensure-db] provider=${provider}`);
const cwd = resolve(__dirname, "..");
const prismaCli = [
  resolve(cwd, "node_modules/prisma/build/index.js"),
  resolve(cwd, "../../node_modules/prisma/build/index.js"),
].find((file) => existsSync(file));
if (!prismaCli) {
  // Missing CLI must not kill the web process. Start uses the client from the build.
  console.error("[ensure-db] prisma CLI not found — skipping schema sync");
  process.exit(0);
}
function prisma(args) {
  // Call node directly. A missing `npx` or engine binary exits 127 and must not stop the API.
  try {
    execFileSync(process.execPath, [prismaCli, ...args], {
      stdio: "inherit",
      env: process.env,
      cwd,
    });
    return true;
  } catch (error) {
    const status = error && error.status != null ? error.status : "?";
    console.error(`[ensure-db] prisma ${args[0]} failed status=${status}`);
    return false;
  }
}
const generated = prisma(["generate", "--schema", "prisma/schema.runtime.prisma"]);
if (generated) {
  // Never accept data loss — a missing model in schema.prisma was wiping CallDevice / fcmToken on every Render boot.
  prisma(["db", "push", "--skip-generate", "--schema", "prisma/schema.runtime.prisma"]);
}
console.log("[ensure-db] schema step finished");
process.exit(0);
