const { mkdirSync } = require("fs");
const { dirname, resolve } = require("path");
const { execSync } = require("child_process");

// Render has no persistent disk on free tier — SQLite is fine for bring-up.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./data/talk.db";
}

const url = process.env.DATABASE_URL;
if (url.startsWith("file:")) {
  const filePath = url.replace(/^file:/, "");
  const abs = resolve(process.cwd(), filePath);
  mkdirSync(dirname(abs), { recursive: true });
}

console.log(`[ensure-db] DATABASE_URL=${url}`);
execSync("npx prisma db push --skip-generate --accept-data-loss", {
  stdio: "inherit",
  env: process.env,
  cwd: resolve(__dirname, ".."),
});
console.log("[ensure-db] schema ready");
