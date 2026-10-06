import { User } from "@prisma/client";
import { isLanguageCode, PublicUser } from "@talk/shared";
import { currentLanBase } from "../lan-base";

function mediaUrl(path?: string | null) {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${currentLanBase()}${path}`;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    phoneE164: user.phoneE164,
    displayName: user.displayName,
    avatarUrl: mediaUrl(user.avatarUrl),
    speakLang: isLanguageCode(user.speakLang) ? user.speakLang : "he",
    listenLang: isLanguageCode(user.listenLang) ? user.listenLang : "he",
    voiceGender:
      user.voiceGender === "female" || user.voiceGender === "child" ? user.voiceGender : "male",
    voiceCloneStatus: user.voiceCloneStatus,
    plan: user.plan === "PLUS" ? "PLUS" : "FREE",
    createdAt: user.createdAt.toISOString(),
  };
}
