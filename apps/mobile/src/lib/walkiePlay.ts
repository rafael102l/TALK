import { TransmissionReadyPayload } from "@talk/shared";
import { isMicRecording, stopPlayback } from "./audio";
import { stopRobot } from "./onDeviceAi";

/** Auto-play only while the walkie is still "live". Older clips wait for a tap. */
export const WALKIE_FRESH_MS = 45_000;

let playGen = 0;

export function walkieStamp(payload: Pick<TransmissionReadyPayload, "readyAt" | "releasedAt">) {
  const n = Number(payload.readyAt || payload.releasedAt || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isFreshWalkie(payload: Pick<TransmissionReadyPayload, "readyAt" | "releasedAt">) {
  const stamp = walkieStamp(payload);
  if (!stamp) return false;
  return Date.now() - stamp <= WALKIE_FRESH_MS;
}

/**
 * Latest wins: stop whatever is playing and run only this job.
 * Prevents overlapping shout-piles when several READY events arrive late.
 */
export async function playWalkieExclusive(run: (cancelled: () => boolean) => Promise<void>): Promise<void> {
  // Local PTT owns the device — never start/steal playback mid-record.
  if (isMicRecording()) return;
  const my = ++playGen;
  const cancelled = () => my !== playGen || isMicRecording();
  try {
    await stopRobot();
  } catch {
    /* ignore */
  }
  try {
    await stopPlayback();
  } catch {
    /* ignore */
  }
  if (cancelled()) return;
  await run(cancelled);
}

export function resetWalkiePlayGate() {
  playGen += 1;
}
