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
  console.error("[ensure-db] prisma CLI not found");
  process.exit(1);
}
function prisma(args) {
  // Call node directly. `npx prisma` exits 127 on Render when npx is not on PATH.
  execFileSync(process.execPath, [prismaCli, ...args], {
    stdio: "inherit",
    env: process.env,
    cwd,
  });
}
prisma(["generate", "--schema", "prisma/schema.runtime.prisma"]);
prisma(["db", "push", "--skip-generate", "--schema", "prisma/schema.runtime.prisma"]);
console.log("[ensure-db] schema ready");
