import { BadRequestException, Injectable } from "@nestjs/common";
import { User } from "@prisma/client";
import { hashPhone, isSupportedCountry, PhoneLookupResult, SOCKET_EVENTS, toE164, type CountryCode } from "@talk/shared";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { toPublicUser } from "../users/user.mapper";

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private salt() {
    return process.env.CONTACT_HASH_SALT ?? "talk-contact-salt-dev";
  }

  private parsePhone(phone: string, country?: string) {
    const fallback =
      country && isSupportedCountry(country.toUpperCase()) ? (country.toUpperCase() as CountryCode) : "IL";
    if (phone.trim().startsWith("+")) return toE164(phone);
    return toE164(phone, fallback) ?? toE164(phone, "US");
  }

  async lookup(owner: User, phone: string, country?: string): Promise<PhoneLookupResult> {
    const phoneE164 = this.parsePhone(phone, country);
    if (!phoneE164) {
      return { phoneE164: null, self: false, user: null };
    }
    if (phoneE164 === owner.phoneE164) {
      return { phoneE164, self: true, user: null };
    }
    const found = await this.prisma.user.findUnique({ where: { phoneE164 } });
    return {
      phoneE164,
      self: false,
      user: found ? toPublicUser(found) : null,
    };
  }

  async add(owner: User, phone: string) {
    const result = await this.lookup(owner, phone);
    if (result.self) throw new BadRequestException("זה המספר שלכם");
    if (!result.user || !result.phoneE164) throw new BadRequestException("אין מישהו עם TALK במספר הזה");
    const other = await this.prisma.user.findUnique({ where: { id: result.user.id } });
    if (!other) throw new BadRequestException("אין מישהו עם TALK במספר הזה");
    const blocked = await this.prisma.contact.findFirst({
      where: { ownerId: other.id, matchedUserId: owner.id, status: "BLOCKED" },
    });
    if (blocked) throw new BadRequestException("המשתמש לא מקבל בקשות");
    await this.upsertLink(owner, other, "ACCEPTED");
    await this.ensureIncoming(other, owner);
    return this.list(owner);
  }

  async accept(owner: User, userId: string) {
    const other = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!other || other.id === owner.id) {
      throw new BadRequestException(
        "המשתמש לא רשום בשרת הנוכחי. בקשו ממנו להתחבר מחדש ואז חפשו את המספר שלו.",
      );
    }
    await this.upsertLink(owner, other, "ACCEPTED");
    await this.upsertLink(other, owner, "ACCEPTED");
    this.realtime.emitToUser(other.id, SOCKET_EVENTS.CONTACT_ACCEPTED, {
      user: toPublicUser(owner),
    });
    return this.list(owner);
  }

  async block(owner: User, userId: string) {
    const other = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!other || other.id === owner.id) {
      throw new BadRequestException(
        "המשתמש לא רשום בשרת הנוכחי. בקשו ממנו להתחבר מחדש ואז חפשו את המספר שלו.",
      );
    }
    await this.upsertLink(owner, other, "BLOCKED");
    return this.list(owner);
  }

  async ensureIncoming(recipient: User, from: User) {
    if (recipient.id === from.id) return;
    const existing = await this.prisma.contact.findUnique({
      where: {
        ownerId_phoneHash: { ownerId: recipient.id, phoneHash: hashPhone(from.phoneE164, this.salt()) },
      },
    });
    if (existing?.status === "BLOCKED") return;
    if (existing?.status === "ACCEPTED" && existing.matchedUserId === from.id) return;
    if (existing?.status === "PENDING" && existing.matchedUserId === from.id) return;
    await this.upsertLink(recipient, from, existing?.status === "ACCEPTED" ? "ACCEPTED" : "PENDING");
    if (existing?.status !== "ACCEPTED") {
      this.realtime.emitToUser(recipient.id, SOCKET_EVENTS.CONTACT_REQUEST, {
        user: toPublicUser(from),
      });
    }
  }

  async ensureMutualTalk(a: User, b: User) {
    if (a.id === b.id) return;
    const blocked = await this.prisma.contact.findFirst({
      where: {
        OR: [
          { ownerId: a.id, matchedUserId: b.id, status: "BLOCKED" },
          { ownerId: b.id, matchedUserId: a.id, status: "BLOCKED" },
          { ownerId: a.id, phoneHash: hashPhone(b.phoneE164, this.salt()), status: "BLOCKED" },
          { ownerId: b.id, phoneHash: hashPhone(a.phoneE164, this.salt()), status: "BLOCKED" },
        ],
      },
    });
    if (blocked) return;
    await this.upsertLink(a, b, "ACCEPTED");
    await this.upsertLink(b, a, "ACCEPTED");
  }

  async sync(owner: User, items: { phone: string; displayName?: string }[]) {
    const salt = this.salt();
    const normalized = items
      .map((item) => {
        const phoneE164 = toE164(item.phone) ?? toE164(item.phone, "US");
        if (!phoneE164 || phoneE164 === owner.phoneE164) return null;
        return {
          phoneE164,
          phoneHash: hashPhone(phoneE164, salt),
          displayName: item.displayName?.trim() || "",
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const hashes = [...new Set(normalized.map((c) => c.phoneHash))];
    const existingUsers = await this.prisma.user.findMany({
      where: { phoneHash: { in: hashes } },
    });
    const byHash = new Map(existingUsers.map((u) => [u.phoneHash, u]));

    for (const contact of normalized) {
      const matched = byHash.get(contact.phoneHash);
      const displayName = matched?.displayName?.trim() || contact.displayName || contact.phoneE164;
      const current = await this.prisma.contact.findUnique({
        where: { ownerId_phoneHash: { ownerId: owner.id, phoneHash: contact.phoneHash } },
      });
      if (current?.status === "BLOCKED") continue;
      if (
        current &&
        current.phoneE164 === contact.phoneE164 &&
        current.displayName === displayName &&
        current.matchedUserId === (matched?.id ?? current.matchedUserId)
      ) {
        continue;
      }
      await this.prisma.contact.upsert({
        where: { ownerId_phoneHash: { ownerId: owner.id, phoneHash: contact.phoneHash } },
        create: {
          ownerId: owner.id,
          phoneE164: contact.phoneE164,
          phoneHash: contact.phoneHash,
          displayName,
          matchedUserId: matched?.id,
          status: "ACCEPTED",
        },
        update: {
          phoneE164: contact.phoneE164,
          displayName,
          matchedUserId: matched?.id ?? undefined,
        },
      });
    }

    return this.list(owner);
  }

  async list(owner: User) {
    const rows = await this.prisma.contact.findMany({
      where: { ownerId: owner.id, NOT: { status: "BLOCKED" } },
      include: { matchedUser: true },
      orderBy: { displayName: "asc" },
    });
    const seen = new Set<string>();
    const unique = rows.filter((row) => {
      const key = row.matchedUserId || row.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.map((row) => ({
      id: row.id,
      displayName: row.matchedUser?.displayName?.trim() || row.displayName,
      phoneE164: row.phoneE164,
      matchedUser: row.matchedUser ? toPublicUser(row.matchedUser) : null,
      status: row.status,
      incoming: row.status === "PENDING",
    }));
  }

  async invite(owner: User, phone: string, displayName?: string, country?: string) {
    const phoneE164 = this.parsePhone(phone, country);
    if (!phoneE164) throw new BadRequestException("מספר טלפון לא תקין");
    const body = `${owner.displayName || "מישהו"} מזמין אותך ל-TALK — אוקי-טוקי עם תרגום קול. הורידו את האפליקציה והירשמו עם המספר שלכם.`;
    const sent = await this.auth.sendSms(phoneE164, body);
    const salt = this.salt();
    await this.prisma.contact.upsert({
      where: {
        ownerId_phoneHash: { ownerId: owner.id, phoneHash: hashPhone(phoneE164, salt) },
      },
      create: {
        ownerId: owner.id,
        phoneE164,
        phoneHash: hashPhone(phoneE164, salt),
        displayName: displayName?.trim() || phoneE164,
        status: "ACCEPTED",
      },
      update: { phoneE164 },
    });
    return { sent, smsBody: body, phoneE164 };
  }

  private async upsertLink(owner: User, other: User, status: "PENDING" | "ACCEPTED" | "BLOCKED") {
    const phoneHash = hashPhone(other.phoneE164, this.salt());
    const displayName = other.displayName?.trim() || other.phoneE164;
    await this.prisma.contact.upsert({
      where: { ownerId_phoneHash: { ownerId: owner.id, phoneHash } },
      create: {
        ownerId: owner.id,
        phoneE164: other.phoneE164,
        phoneHash,
        displayName,
        matchedUserId: other.id,
        status,
      },
      update: {
        phoneE164: other.phoneE164,
        displayName,
        matchedUserId: other.id,
        status,
      },
    });
  }
}
