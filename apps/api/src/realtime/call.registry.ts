import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

export type LiveCall = {
  callId: string;
  callerId: string;
  calleeId: string;
  invitedIds: string[];
  joinedIds: string[];
  channelId?: string;
  groupName?: string;
  callerName: string;
  callerPhone: string;
  callerAvatar: string | null;
  callerGender: string;
  video: boolean;
  accepted: boolean;
  openedAt: number;
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

const CALL_TTL_SEC = 90;

@Injectable()
export class CallRegistry {
  private readonly calls = new Map<string, LiveCall>();
  private readonly missed = new Map<string, MissedCall[]>();
  private readonly ended = new Set<string>();

  constructor(private readonly redis: RedisService) {}

  open(call: LiveCall) {
    this.calls.set(call.callId, call);
    this.persist(call);
  }

  get(callId: string) {
    return this.calls.get(callId);
  }

  async load(callId: string): Promise<LiveCall | undefined> {
    const id = callId.trim();
    if (!id || this.ended.has(id)) return undefined;
    const mem = this.calls.get(id);
    if (mem) return mem;
    const raw = await this.redis.get(this.key(id));
    if (!raw) return undefined;
    try {
      const call = JSON.parse(raw) as LiveCall;
      if (!call?.callId) return undefined;
      if (!call.openedAt) call.openedAt = Date.now();
      this.calls.set(id, call);
      return call;
    } catch {
      return undefined;
    }
  }

  inCall(call: LiveCall, userId: string) {
    return (
      call.callerId === userId ||
      call.calleeId === userId ||
      call.invitedIds.includes(userId) ||
      call.joinedIds.includes(userId)
    );
  }

  busy(userId: string, exceptCallId?: string) {
    for (const call of this.calls.values()) {
      if (exceptCallId && call.callId === exceptCallId) continue;
      if (this.inCall(call, userId)) return call;
    }
    return undefined;
  }

  async busyNow(userId: string, exceptCallId?: string) {
    const mem = this.busy(userId, exceptCallId);
    if (mem) return mem;
    const id = (await this.redis.get(this.busyKey(userId)))?.trim() || "";
    if (!id || id === exceptCallId || this.ended.has(id)) return undefined;
    return this.load(id);
  }

  other(callId: string, userId: string) {
    const call = this.calls.get(callId);
    if (!call) return "";
    if (call.joinedIds.length > 2 || call.invitedIds.length > 1) return "";
    if (call.callerId === userId) return call.calleeId;
    if (call.calleeId === userId) return call.callerId;
    return "";
  }

  others(callId: string, userId: string) {
    const call = this.calls.get(callId);
    if (!call) return [];
    return [...new Set([call.callerId, ...call.joinedIds, ...call.invitedIds])].filter((id) => id && id !== userId);
  }

  touch(call: LiveCall) {
    this.persist(call);
  }

  end(callId: string) {
    const call = this.calls.get(callId);
    if (call?.timer) clearTimeout(call.timer);
    this.calls.delete(callId);
    this.ended.add(callId);
    setTimeout(() => this.ended.delete(callId), 120_000);
    void this.redis.del(this.key(callId));
    for (const userId of this.partyIds(call)) void this.redis.del(this.busyKey(userId));
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

  private key(callId: string) {
    return `talk:call:${callId}`;
  }

  private busyKey(userId: string) {
    return `talk:busy:${userId}`;
  }

  private partyIds(call?: LiveCall | null) {
    if (!call) return [];
    return [...new Set([call.callerId, call.calleeId, ...call.invitedIds, ...call.joinedIds])].filter(Boolean);
  }

  private persist(call: LiveCall) {
    const { timer: _timer, ...rest } = call;
    if (!rest.openedAt) rest.openedAt = Date.now();
    void this.redis.set(this.key(call.callId), JSON.stringify(rest), CALL_TTL_SEC);
    for (const userId of this.partyIds(call)) {
      void this.redis.set(this.busyKey(userId), call.callId, CALL_TTL_SEC);
    }
  }
}
