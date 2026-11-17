export const COMPANY_VALUATION_USD = 22_000_000_000;
export const INVESTOR_POOL_PCT = 20;
export const MIN_INVEST_USD = 1;
export const MAX_INVEST_USD = 1_000_000;
export const PENDING_TTL_MS = 45 * 60 * 1000;

export function companyPercent(amountUsd: number) {
  return (amountUsd / COMPANY_VALUATION_USD) * 100;
}

export function formatPercent(pct: number) {
  if (!Number.isFinite(pct) || pct <= 0) return "0";
  if (pct >= 0.01) return pct.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return pct.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

export function cardcomLang(code?: string | null) {
  const base = (code || "he").split("-")[0].toLowerCase();
  if (base === "he" || base === "ar" || base === "ru" || base === "en") return base;
  return "en";
}
