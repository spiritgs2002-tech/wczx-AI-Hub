import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 音频转码兜底接口：把任意常见录音格式统一转成 16kHz 单声道 WAV data URL。
 *
 * 为什么需要：学生平板上用 Firefox + Android 文件选择器（"录音机"来源）选到的
 * m4a/aac/3gp/amr/ogg/webm 等格式，浏览器的 AudioContext.decodeAudioData 解不了，
 * 前端只能报"音频解析失败"。服务端用 ffmpeg 兜底后，这些格式都能送进 AI 对话。
 *
 * 📐 CONTRACT：输入 base64（可带 data URL 头），输出 data:audio/wav;base64,...；
 *   临时文件用完即删；ffmpeg 参数用 execFile 数组传递，不拼 shell 字符串。
 * 🔗 RELATED：src/app/student/chat/page.tsx 的 transcodeAudioToWav（浏览器解码失败才调这里）。
 * ⛔ DO NOT REMOVE鉴权：本接口会被局域网任意设备调用来驱动 ffmpeg，必须校验登录态。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

/** 原始音频上限 20MB（与前端一致），转码超时 30 秒 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 30_000;

/** MIME → ffmpeg 输入扩展名白名单；未知 MIME 一律拒绝，避免路径/协议注入 */
const MIME_TO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/3gpp": "3gp",
  "audio/3gpp2": "3g2",
  "audio/amr": "amr",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

function parseAudioBase64(input: string): { data: Buffer; ext: string } | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let mime = "";
  let b64 = input.trim();
  const match = b64.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]*)$/);
  if (match) {
    mime = (match[1] || "").toLowerCase();
    b64 = match[2];
  }
  // 去掉空白与 data URL 里可能夹带的换行
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;

  // 文件名扩展名只能来自白名单；空 MIME 时按字节魔数兜底（Android 常返回空 type）
  let ext = MIME_TO_EXT[mime];
  if (!ext) {
    const head = Buffer.from(b64.slice(0, 32), "base64");
    if (head.slice(0, 4).toString("ascii") === "RIFF") ext = "wav";
    else if (head.slice(4, 8).toString("ascii") === "ftyp") ext = "m4a";
    else if (head.slice(1, 4).toString("ascii") === "ftyp") ext = "m4a";
    else if (head.slice(0, 4).toString("ascii") === "OggS") ext = "ogg";
    else if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ext = "mp3"; // MPEG 帧同步
    else ext = "bin"; // ffmpeg 会按字节自行探测，扩展名仅作提示
  }
  const data = Buffer.from(b64, "base64");
  if (!data.length || data.length > MAX_INPUT_BYTES) return null;
  return { data, ext };
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token || !(await verifyToken(token))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let body: { audio?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = parseAudioBase64(typeof body?.audio === "string" ? body.audio : "");
  if (!parsed) {
    return NextResponse.json({ error: "音频数据无效或超过 20MB" }, { status: 400 });
  }

  const dir = path.join(os.tmpdir(), `wczx-audio-${randomUUID()}`);
  const inputPath = path.join(dir, `input.${parsed.ext}`);
  const outputPath = path.join(dir, "output.wav");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(inputPath, parsed.data);
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
    const wav = await readFile(outputPath);
    if (!wav.length || wav.slice(0, 4).toString("ascii") !== "RIFF") {
      throw new Error("ffmpeg 未生成有效 WAV");
    }
    const dataUrl = `data:audio/wav;base64,${wav.toString("base64")}`;
    return NextResponse.json({ ok: true, dataUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 不把临时路径、ffmpeg 详细日志暴露给前端（含服务端目录信息）
    return NextResponse.json(
      { error: "音频转码失败，请换用常见格式（m4a/mp3/wav）或页面内录音", detail: msg.slice(0, 120) },
      { status: 500 }
    );
  } finally {
    await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
  }
}
