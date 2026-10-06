/** Debug timing helper. Never throws — must not block the mic. */
export function clockLog(_phase?: string, _marks?: Record<string, number | string | undefined>) {
  try {
    /* no-op in release; keep the call sites safe */
  } catch {
    /* ignore */
  }
}
