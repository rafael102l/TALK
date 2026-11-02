export type AdminIncident = {
  id: string;
  at: string;
  kind: "server" | "security" | "db";
  status: number;
  path: string;
  method: string;
  message: string;
  detail: string;
};

const MAX = 100;
const incidents: AdminIncident[] = [];
let seq = 0;

export function pushIncident(input: {
  kind?: AdminIncident["kind"];
  status?: number;
  path?: string;
  method?: string;
  message: string;
  detail?: string;
}) {
  const status = input.status ?? 500;
  const kind =
    input.kind ??
    (status === 401 || status === 403
      ? "security"
      : /pool|P2024|database|prisma|ECONN|timeout/i.test(`${input.message} ${input.detail || ""}`)
        ? "db"
        : "server");
  const row: AdminIncident = {
    id: `inc_${Date.now()}_${++seq}`,
    at: new Date().toISOString(),
    kind,
    status,
    path: (input.path || "").slice(0, 200),
    method: (input.method || "").slice(0, 12),
    message: String(input.message || "שגיאה").slice(0, 400),
    detail: String(input.detail || "").slice(0, 1200),
  };
  incidents.unshift(row);
  if (incidents.length > MAX) incidents.length = MAX;
  return row;
}

export function listIncidents(limit = 60): AdminIncident[] {
  return incidents.slice(0, Math.max(1, Math.min(limit, MAX)));
}

export function clearIncidents() {
  incidents.length = 0;
}

export function openServerIncidentCount(windowMs = 15 * 60 * 1000) {
  const since = Date.now() - windowMs;
  return incidents.filter((row) => {
    if (row.kind === "security") return false;
    return new Date(row.at).getTime() >= since && row.status >= 500;
  }).length;
}

export function openSecurityIncidentCount(windowMs = 60 * 60 * 1000) {
  const since = Date.now() - windowMs;
  return incidents.filter((row) => row.kind === "security" && new Date(row.at).getTime() >= since).length;
}
