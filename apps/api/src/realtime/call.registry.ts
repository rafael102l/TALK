import { Injectable } from "@nestjs/common";

export type LiveCall = {
  callId: string;
  callerId: string;
  calleeId: string;
  accepted: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export type MissedCall = {
  callId: string;
  peerId: string;
  peerName: string;
  avatarUrl: string | null;
  gender: string;
  at: string;
};

@Injectable()
export class CallRegistry {
  private readonly calls = new Map<string, LiveCall>();
  private readonly missed = new Map<string, MissedCall[]>();

  open(call: LiveCall) {
    this.calls.set(call.callId, call);
  }

  get(callId: string) {
    return this.calls.get(callId);
  }

  busy(userId: string) {
    for (const call of this.calls.values()) {
      if (call.callerId === userId || call.calleeId === userId) return call;
    }
    return undefined;
  }

  other(callId: string, userId: string) {
    const call = this.calls.get(callId);
    if (!call) return "";
    if (call.callerId === userId) return call.calleeId;
    if (call.calleeId === userId) return call.callerId;
    return "";
  }

  end(callId: string) {
    const call = this.calls.get(callId);
    if (call?.timer) clearTimeout(call.timer);
    this.calls.delete(callId);
  }

  rememberMissed(userId: string, entry: MissedCall) {
    const list = this.missed.get(userId) ?? [];
    if (list.some((row) => row.callId === entry.callId)) return;
    this.missed.set(userId, [entry, ...list].slice(0, 20));
  }

  takeMissed(userId: string) {
    const list = this.missed.get(userId) ?? [];
    this.missed.delete(userId);
    return list;
  }
}
