const fs = require("fs");
const path = require("path");

const goldPath = path.join(__dirname, "..", "src", "ai", "he-ru.gold.json");
const gold = JSON.parse(fs.readFileSync(goldPath, "utf8"));

function normalizeAnchor(text) {
  return String(text)
    .toLowerCase()
    .replace(/[.,!?:"'«»״׳]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATION = {
  he: ["לא", "אין", "אל", "בלי"],
  ru: ["не", "нет", "ни", "без"],
};

function missingAnchors(translated, spec) {
  const hay = normalizeAnchor(translated);
  const missing = [];
  for (const token of spec.keep || []) {
    const needle = normalizeAnchor(token);
    if (needle && !hay.includes(needle)) missing.push(token);
  }
  if (spec.negation) {
    const marks = NEGATION[spec.target] || [];
    if (!marks.some((mark) => hay.includes(normalizeAnchor(mark)))) missing.push("NEGATION");
  }
  return missing;
}

function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key]) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

async function translateLive(text, source, target, key) {
  const names = ["נועם", "Ноам", "בוריס", "Борис", "רפאל", "Рафаэль", "מנהל"];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: [
            `A person spoke this walkie-talkie message in ${source}.`,
            "Understand the whole sentence first, including slang and informal speech.",
            `Then say that same sentence in ${target} as a native speaker would.`,
            "Same meaning and attitude. Do not invent or drop clauses.",
            "Keep personal names exactly as said.",
            `Names that may appear: ${names.join(", ")}.`,
            "Return only the translation once.",
          ].join(" "),
        },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const items = gold.items || [];
  if (items.length < 40) {
    console.error(`gold set has ${items.length} items, need 40`);
    process.exit(1);
  }
  let failed = 0;
  for (const item of items) {
    const missing = missingAnchors(item.reference, {
      keep: item.keep,
      negation: item.negation,
      target: item.target,
    });
    if (missing.length) {
      failed += 1;
      console.error(`REF FAIL ${item.id}: ${missing.join(", ")}`);
    }
  }
  if (failed) {
    console.error(`reference check failed: ${failed}/${items.length}`);
    process.exit(1);
  }
  console.log(`reference check passed: ${items.length} items`);

  loadEnv();
  const key = process.env.OPENAI_API_KEY;
  if (!key || process.env.EVAL_LIVE !== "1") {
    console.log("skip live eval (set EVAL_LIVE=1 to call OpenAI)");
    return;
  }

  let liveFail = 0;
  for (const item of items) {
    const out = await translateLive(item.text, item.source, item.target, key);
    const missing = missingAnchors(out, {
      keep: item.keep,
      negation: item.negation,
      target: item.target,
    });
    if (missing.length) {
      liveFail += 1;
      console.error(`LIVE FAIL ${item.id}: missing ${missing.join(", ")} | "${out}"`);
    } else {
      console.log(`LIVE OK ${item.id}`);
    }
  }
  if (liveFail) {
    console.error(`live check failed: ${liveFail}/${items.length}`);
    process.exit(1);
  }
  console.log(`live check passed: ${items.length} items`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
