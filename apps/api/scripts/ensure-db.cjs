const { mkdirSync, readFileSync, writeFileSync } = require("fs");
const { dirname, resolve } = require("path");
const { execSync } = require("child_process");

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
execSync("npx prisma generate --schema prisma/schema.runtime.prisma", {
  stdio: "inherit",
  env: process.env,
  cwd,
});
execSync("npx prisma db push --skip-generate --schema prisma/schema.runtime.prisma", {
  stdio: "inherit",
  env: process.env,
  cwd,
});
console.log("[ensure-db] schema ready");
