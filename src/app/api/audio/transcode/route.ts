import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
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

/** MIME → 支持的容器；空或未知 MIME 仅接受已识别的音频文件头 */
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

  if (b64.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4) return null;
  const data = Buffer.from(b64, "base64");
  if (!data.length || data.length > MAX_INPUT_BYTES) return null;
  const ext = Object.hasOwn(MIME_TO_EXT, mime) ? MIME_TO_EXT[mime] : detectAudioFormat(data);
  if (!ext) return null;
  return { data, ext };
}

// DO NOT AUTO-DETECT ARBITRARY DEMUXERS: force a supported audio container and deny network protocols.
// 📐 CONTRACT: no playlists or external tracks; 🔗 RELATED: student/chat audio attachment fallback.
const DEMUXERS: Record<string, string> = {
  mp3: "mp3", m4a: "mov", aac: "aac", ogg: "ogg", webm: "matroska",
  wav: "wav", "3gp": "mov", "3g2": "mov", amr: "amr", flac: "flac",
};
function detectAudioFormat(data: Buffer): string | undefined {
  if (data.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (data.toString("ascii", 0, 4) === "RIFF") return "wav";
  if (data.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (data.toString("ascii", 0, 4) === "fLaC") return "flac";
  if (data.toString("ascii", 0, 5) === "#!AMR") return "amr";
  if (data.readUintBE(0, Math.min(data.length, 4)) === 0x1a45dfa3) return "webm";
  if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return "aac";
  if (data.toString("ascii", 0, 3) === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "mp3";
}

const MAX_BODY_BYTES = Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 1024;
const MAX_DURATION_SECONDS = 120;
const OUTPUT_SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = MAX_DURATION_SECONDS * OUTPUT_SAMPLE_RATE * 2; // 单声道 PCM s16le
const MAX_WAV_BYTES = MAX_PCM_BYTES + 44 + 1024;
let activeRequests = 0;

// DO NOT MEASURE THE RIFF FILE SIZE: FFmpeg may add LIST metadata and padding around the PCM.
// 📐 CONTRACT: exactly 120 seconds is allowed; the data chunk excludes container overhead.
// 🔗 RELATED: output format, sample rate and -fs cap in POST below.
// ⛔ DO NOT REVERT: -fs bounds the temporary file, but cannot determine its audio duration.
function wavPcmBytes(wav: Buffer): number {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("无效 WAV");
  }
  for (let offset = 12; offset + 8 <= wav.length;) {
    const bytes = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + bytes;
    if (end > wav.length) break;
    if (wav.toString("ascii", offset, offset + 4) === "data" && bytes > 0) return bytes;
    offset = end + (bytes % 2);
  }
  throw new Error("无效 WAV 数据块");
}

async function readAudioRequest(req: NextRequest) {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, FFMPEG_TIMEOUT_MS);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    if (timedOut) return null;
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as { audio?: unknown } | null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token || !(await verifyToken(token))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  // ⛔ DO NOT REVERT: cap concurrent reads and child processes before reading the request.
  // 📐 CONTRACT: bounds apply per server process; 🔗 RELATED: input/output caps below.
  if (activeRequests >= 2) {
    return NextResponse.json({ error: "音频转码繁忙，请稍后重试" }, { status: 429 });
  }
  activeRequests++;
  let dir: string | undefined;
  try {
    const body = await readAudioRequest(req).catch(() => null);
    const parsed = parseAudioBase64(typeof body?.audio === "string" ? body.audio : "");
    if (!parsed) {
      return NextResponse.json({ error: "音频格式无效或超过 20MB" }, { status: 400 });
    }
    dir = await mkdtemp(path.join(os.tmpdir(), "wczx-audio-"));
    const inputPath = path.join(dir, "input." + parsed.ext);
    const outputPath = path.join(dir, "output.wav");
    await writeFile(inputPath, parsed.data);
    const demuxer = DEMUXERS[parsed.ext];
    await execFileAsync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-protocol_whitelist", "file", "-f", demuxer,
      ...(demuxer === "mov" ? ["-enable_drefs", "0"] : []),
      "-i", inputPath, "-map", "0:a:0", "-map_metadata", "-1",
      "-ac", "1", "-ar", String(OUTPUT_SAMPLE_RATE), "-c:a", "pcm_s16le",
      "-t", String(MAX_DURATION_SECONDS + 1), "-fs", String(MAX_WAV_BYTES), outputPath,
    ], { timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    const wav = await readFile(outputPath);
    if (wavPcmBytes(wav) > MAX_PCM_BYTES) {
      return NextResponse.json({ error: "音频超过 120 秒，请缩短后重试" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, dataUrl: "data:audio/wav;base64," + wav.toString("base64") });
  } catch {
    return NextResponse.json({ error: "音频转码失败，请换用常见格式（m4a/mp3/wav）或页面内录音" }, { status: 500 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    activeRequests--;
  }
}
