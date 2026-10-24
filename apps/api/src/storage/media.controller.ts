import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { StorageService } from "./storage.service";

@Controller("media")
export class MediaController {
  constructor(private readonly storage: StorageService) {}

  @Get("audio/:name")
  async audio(@Param("name") name: string, @Req() req: Request, @Res() res: Response) {
    const file = await this.storage.readAudio(name);
    if (!file) {
      console.warn(`[audio] missing ${name}`);
      res.status(404).json({ message: "missing" });
      return;
    }
    console.log(`[audio] play ${name} bytes=${file.body.length}`);
    sendAudio(req, res, file.body, file.mime);
  }

  @Get("chat/:name")
  async chat(@Param("name") name: string, @Req() req: Request, @Res() res: Response) {
    const file = await this.storage.readChat(name);
    if (!file) {
      console.warn(`[chat] missing ${name}`);
      res.status(404).json({ message: "missing" });
      return;
    }
    sendAudio(req, res, file.body, file.mime);
  }
}

function sendAudio(req: Request, res: Response, body: Buffer, mime: string) {
  const total = body.length;
  const range = req.headers.range;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2] || 0));
    const end = match[2] && match[1] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start < total && start <= end) {
      const chunk = Buffer.from(body.subarray(start, end + 1));
      res.writeHead(206, {
        "Content-Type": mime,
        "Content-Length": chunk.length,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-transform",
      });
      res.end(chunk);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": total,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-transform",
  });
  res.end(body);
}
