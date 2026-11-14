import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);
const MAGIC = Buffer.from("WCZXBACKUP\x01", "binary");
const SALT_SIZE = 16;
const IV_SIZE = 12;
const TAG_SIZE = 16;

// MUST AUTHENTICATE BACKUPS: 教师备份包含 API 密钥和学生数据，文件必须用用户密码加密并验证完整性。
// 📐 CONTRACT: 魔数版本 + 16 字节盐 + 12 字节 IV + 16 字节 GCM 标签 + 密文；密码从不写入文件。
// 🔗 RELATED: 教师数据导入导出接口、备份格式版本与恢复校验；变更格式必须保留旧版解密能力。
// ⛔ DO NOT REVERT: 不允许明文回退或忽略 GCM 验证；密码错误与文件损坏均拒绝恢复。
export async function encryptTeacherBackup(data: Buffer, password: string): Promise<Buffer> {
  if (!password) throw new Error("请输入备份密码");
  const salt = randomBytes(SALT_SIZE);
  const iv = randomBytes(IV_SIZE);
  const key = await scrypt(password, salt, 32) as Buffer;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

export async function decryptTeacherBackup(data: Buffer, password: string): Promise<Buffer> {
  if (!password || data.length < MAGIC.length + SALT_SIZE + IV_SIZE + TAG_SIZE || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("备份文件格式不正确或密码为空");
  }
  let offset = MAGIC.length;
  const salt = data.subarray(offset, offset += SALT_SIZE);
  const iv = data.subarray(offset, offset += IV_SIZE);
  const tag = data.subarray(offset, offset += TAG_SIZE);
  try {
    const key = await scrypt(password, salt, 32) as Buffer;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]);
  } catch {
    throw new Error("密码错误或备份文件已损坏");
  }
}
