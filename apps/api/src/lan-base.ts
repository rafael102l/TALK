import { networkInterfaces } from "os";

/** Current Wi-Fi address of this computer, so phones on the same network can open media. */
export function currentLanBase() {
  const port = process.env.PORT ?? "3000";
  const addresses: string[] = [];
  for (const rows of Object.values(networkInterfaces())) {
    for (const row of rows ?? []) {
      const family = String(row.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (row.internal) continue;
      if (row.address.startsWith("169.254.")) continue;
      addresses.push(row.address);
    }
  }
  const ip =
    addresses.find((address) => address.startsWith("192.168.") || address.startsWith("10.")) ??
    addresses[0];
  if (!ip) return (process.env.API_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `http://${ip}:${port}`;
}
