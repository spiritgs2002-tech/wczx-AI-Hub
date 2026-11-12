import { SignJWT, jwtVerify } from "jose";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * JWT 签名密钥
 *
 * 为什么这样写：历史上 .env.example 写死了 NEXTAUTH_SECRET，启动脚本直接复制模板生成 .env，
 *   代码里还有固定的兜底值 —— 所有部署共用同一个公开密钥，任何看过仓库的人都能伪造教师 token（2026-11-11 体检发现）。
 * 现状：
 *   1. .env 的 NEXTAUTH_SECRET 若是自定义的强密钥（≥32 字符且不在下方公开值清单里）→ 直接使用；
 *   2. 否则使用项目根目录的 .auth-secret（首次使用时随机生成 48 字节并持久化，权限 600，已 gitignore）。
 * ⛔ DO NOT REVERT：不要再加回任何硬编码兜底密钥，也不要把公开值清单删掉（旧部署的 .env 里仍是这些值）。
 * ⚠️ GOTCHA：密钥在首次签发/校验 token 时才生成（懒加载），保证 next build 不会产出 .auth-secret 并被打进安装包。
 *   更换密钥会让所有已登录用户的 token 失效，需要重新登录 —— 这是预期行为。
 * 🔗 RELATED：.gitignore（.auth-secret）、.env.example（NEXTAUTH_SECRET 说明）。
 */
const KNOWN_PUBLIC_SECRETS = new Set([
  "wczx-ai-hub-secret-key-2024",
  "wczx-ai-hub-secret-key-2026",
  "quickclass-secret-key-2024",
  "quickclass-secret-key-2026",
]);
const SECRET_FILE = path.join(process.cwd(), ".auth-secret");

let cachedSecret: Uint8Array | null = null;

function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const fromEnv = (process.env.NEXTAUTH_SECRET || "").trim();
  let value: string;
  if (fromEnv.length >= 32 && !KNOWN_PUBLIC_SECRETS.has(fromEnv)) {
    value = fromEnv;
  } else {
    value = readOrCreateSecretFile();
  }
  cachedSecret = new TextEncoder().encode(value);
  return cachedSecret;
}

function readOrCreateSecretFile(): string {
  try {
    const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 文件不存在，下面生成
  }
  const generated = crypto.randomBytes(48).toString("base64url");
  try {
    // wx：若并发进程已抢先写入则失败，转而读取对方写入的值，保证全进程同一密钥
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600, flag: "wx" });
    return generated;
  } catch {
    const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  }
}

/**
 * 密码指纹（pv）：令牌签发时记录「当前密码哈希」的摘要，校验时比对。
 * 为什么：令牌有效期 7 天且原先无法吊销，改密码/找回密码后旧令牌仍可用（2026-11-11 体检发现）。
 * 现状：密码一变，指纹不同，旧令牌立即失效；用户被删除时令牌同样失效。代价是每次校验多一次按主键查询（SQLite 本地，可忽略）。
 * ⛔ DO NOT REMOVE 校验里的 pv 比对；也不要把明文/哈希本身放进令牌，只放截断摘要。
 * 🔗 RELATED：改密码后需重新签发令牌给当前用户 —— 见 src/app/api/auth/teacher/profile/route.ts PUT。
 */
function passwordFingerprint(passwordHash: string | null | undefined): string {
  return crypto.createHash("sha256").update("pv:" + (passwordHash || "")).digest("hex").slice(0, 16);
}

async function currentFingerprint(userId: string): Promise<string | null> {
  // 动态引入，避免本模块被非 Node 运行时代码静态依赖到 Prisma
  const { prisma } = await import("@/lib/prisma");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  return user ? passwordFingerprint(user.password) : null;
}

export async function createToken(payload: Record<string, unknown>) {
  const userId = payload.userId ? String(payload.userId) : "";
  const pv = userId ? await currentFingerprint(userId) : null;
  return new SignJWT({ ...payload, ...(pv ? { pv } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { clockTolerance: 60 });
    // ⛔ 带 purpose 的令牌只能用于特定用途，一律不得当作登录令牌（防御性校验，DO NOT REMOVE）
    if (payload.purpose) return null;
    if (!payload.userId) return null;
    const pv = await currentFingerprint(String(payload.userId));
    if (!pv || payload.pv !== pv) return null;
    return payload;
  } catch {
    return null;
  }
}
