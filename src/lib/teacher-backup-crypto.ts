import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "crypto";
const MAGIC_PREFIX = Buffer.from("WCZXBACKUP", "ascii");
const CURRENT_VERSION = 2;
const SALT_SIZE = 16;
const IV_SIZE = 12;
const TAG_SIZE = 16;

// MUST AUTHENTICATE BACKUPS: 教师备份包含 API 密钥和学生数据，文件必须用用户密码加密并验证完整性。
// 📐 CONTRACT: v1 使用 scrypt 默认 N=16384；新备份 v2 使用 N=131072、r=8、p=1，保留 v1 解密。
// 🔗 RELATED: 教师数据导入导出接口、备份格式版本与恢复校验；变更格式必须保留旧版解密能力。
// ⛔ DO NOT REVERT: 不允许明文回退或忽略 GCM 验证；密码错误与文件损坏均拒绝恢复。
// MUST BOUND KDF MEMORY: v2 每次约需 128 MiB；同一进程串行派生并限制排队，避免并发耗尽内存。
// 🔗 RELATED: 导出/预检/恢复均使用此函数；调整参数必须新增版本，不得改变已有版本含义。
type KdfQueue = { tail: Promise<void>; waiting: number };
const shared = globalThis as typeof globalThis & { __wczxBackupKdf?: KdfQueue };
const queue = shared.__wczxBackupKdf ??= { tail: Promise.resolve(), waiting: 0 };
async function deriveKey(password: string, salt: Buffer, version: number): Promise<Buffer> {
  if (queue.waiting >= 4) throw new Error("备份加密任务较多，请稍后重试");
  queue.waiting++;
  const job = queue.tail.then(() => new Promise<Buffer>((resolve, reject) => {
    // MUST KEEP VERSION MAPPING IN SYNC: 新增版本时必须保留所有旧版本的固定参数。
    // 📐 CONTRACT: v1 固定 N=16384，v2 固定 N=131072；版本号决定派生参数。
    // 🔗 RELATED: decryptTeacherBackup 的版本白名单、CURRENT_VERSION 和 scripts/test-pr2-review.cjs。
    // ⛔ DO NOT REVERT: 新增版本不能让旧版落入新参数，否则历史备份无法解密。
    const options = version === 1 ? { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } : { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
    scryptCallback(password, salt, 32, options, (error, key) => error ? reject(error) : resolve(key));
  }));
  queue.tail = job.then(() => undefined, () => undefined);
  try { return await job; } finally { queue.waiting--; }
}
export async function encryptTeacherBackup(data: Buffer, password: string): Promise<Buffer> {
  if (!password) throw new Error("请输入备份密码");
  const salt = randomBytes(SALT_SIZE);
  const iv = randomBytes(IV_SIZE);
  const magic = Buffer.concat([MAGIC_PREFIX, Buffer.from([CURRENT_VERSION])]);
  const key = await deriveKey(password, salt, CURRENT_VERSION);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(magic);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([magic, salt, iv, cipher.getAuthTag(), ciphertext]);
}

export async function decryptTeacherBackup(data: Buffer, password: string): Promise<Buffer> {
  const magicLength = MAGIC_PREFIX.length + 1;
  const version = data[MAGIC_PREFIX.length];
  if (!password || data.length < magicLength + SALT_SIZE + IV_SIZE + TAG_SIZE || !data.subarray(0, MAGIC_PREFIX.length).equals(MAGIC_PREFIX) || (version !== 1 && version !== CURRENT_VERSION)) {
    throw new Error("备份文件格式不正确或密码为空");
  }
  const magic = data.subarray(0, magicLength);
  let offset = magicLength;
  const salt = data.subarray(offset, offset += SALT_SIZE);
  const iv = data.subarray(offset, offset += IV_SIZE);
  const tag = data.subarray(offset, offset += TAG_SIZE);
  const key = await deriveKey(password, salt, version);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]);
  } catch {
    throw new Error("密码错误或备份文件已损坏");
  }
}
