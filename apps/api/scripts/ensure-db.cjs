const { mkdirSync } = require("fs");
const { dirname, resolve } = require("path");
const { execSync } = require("child_process");

// Default: local Docker Postgres from docker-compose.yml
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://talk:talk@localhost:5432/talk";
}

const url = process.env.DATABASE_URL;
if (url.startsWith("file:")) {
  console.error(
    "[ensure-db] DATABASE_URL is SQLite (file:...). TALK now requires Postgres so sessions survive Render deploys.\n" +
      "Create a Render Postgres DB and set DATABASE_URL to its Internal Database URL (postgresql://...).",
  );
  process.exit(1);
}

console.log("[ensure-db] provider=postgres");
// Never use --accept-data-loss — that wiped users on schema nudges.
execSync("npx prisma db push --skip-generate", {
  stdio: "inherit",
  env: process.env,
  cwd: resolve(__dirname, ".."),
});
console.log("[ensure-db] schema ready");
