import { Injectable, Logger } from "@nestjs/common";
import { readFile } from "fs/promises";

@Injectable()
export class VoiceCloneService {
  private readonly logger = new Logger(VoiceCloneService.name);

  async clone(userId: string, displayName: string, filePath: string): Promise<string> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) {
      this.logger.warn("ELEVENLABS_API_KEY missing — storing mock voice id");
      return `mock-voice-${userId}`;
    }
    const audio = await readFile(filePath);
    const form = new FormData();
    form.append("name", `talk-${displayName || userId}`);
    form.append("files", new Blob([new Uint8Array(audio)], { type: "audio/m4a" }), "sample.m4a");
    const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (!res.ok) {
      this.logger.warn(`Voice clone failed: ${res.status} ${await res.text()}`);
      throw new Error("שיבוט הקול נכשל");
    }
    const data = (await res.json()) as { voice_id?: string };
    if (!data.voice_id) throw new Error("שיבוט הקול נכשל");
    return data.voice_id;
  }
}
