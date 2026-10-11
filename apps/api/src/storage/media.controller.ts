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
      res.status(404).json({ message: "missing" });
      return;
    }
    sendAudio(req, res, file.body, file.mime);
  }
}

function sendAudio(req: Request, res: Response, body: Buffer, mime: string) {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "private, max-age=86400");
  const range = req.headers.range;
  if (!range) {
    res.status(200);
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
  if (!match || start >= body.length || start > end) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${body.length}`);
    res.end();
    return;
  }
  const chunk = body.subarray(start, end + 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
  res.setHeader("Content-Length", String(chunk.length));
  res.end(chunk);
}
