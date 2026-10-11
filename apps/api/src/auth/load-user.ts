import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const TTL_MS = 20_000;
const users = new Map<string, { user: User; at: number }>();
const channels = new Map<string, { ids: string[]; at: number }>();

function poolFull(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2024";
}

/** A reconnect storm was calling findUnique until the pool stayed full. */
export async function loadUser(prisma: PrismaService, id: string): Promise<User | null> {
  const hit = users.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await prisma.user.findUnique({ where: { id } });
      if (user) users.set(id, { user, at: Date.now() });
      else users.delete(id);
      return user;
    } catch (error) {
      if (poolFull(error) && hit) return hit.user;
      if (poolFull(error) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw error;
    }
  }
  return hit?.user ?? null;
}

export async function loadChannelIds(prisma: PrismaService, userId: string): Promise<string[]> {
  const hit = channels.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  try {
    const rows = await prisma.channelMember.findMany({
      where: { userId },
      select: { channelId: true },
    });
    const ids = rows.map((row) => row.channelId);
    channels.set(userId, { ids, at: Date.now() });
    return ids;
  } catch (error) {
    if (poolFull(error) && hit) return hit.ids;
    throw error;
  }
}
