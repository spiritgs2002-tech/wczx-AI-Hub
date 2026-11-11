import { PrismaClient } from "@prisma/client";

// MUST INITIALIZE SQLITE BEFORE QUERIES: 开发与生产均使用 SQLite；短暂写锁最多等待 5000ms。
// 📐 CONTRACT: 初始化失败必须阻止查询；普通查询、原始 SQL、两种事务入口共用同一个初始化 Promise。
// 🔗 RELATED: prisma/schema.prisma（sqlite）；AGENTS.md §3①、package.json db:push（单文件备份与升级）。
// ⛔ DO NOT ENABLE WAL: 备份/升级只复制 dev.db，WAL 的未合并数据会遗漏；重连后必须重新设置 PRAGMA。
function createPrismaClient(): PrismaClient {
  const client = new PrismaClient();
  const busyTimeoutPragma = "PRAGMA busy_timeout = 5000";
  const connect = client.$connect.bind(client);
  const disconnect = client.$disconnect.bind(client);
  let initialized: Promise<void> | undefined;

  const initialize = () => {
    initialized ??= connect()
      .then(async () => {
        await client.$queryRawUnsafe(busyTimeoutPragma);
      })
      .catch((error: unknown) => {
        initialized = undefined;
        throw error;
      });
    return initialized;
  };

  client.$use(async (params, next) => {
    // MUST BYPASS ONLY THE FIXED PRAGMA: 初始化本身不能等待自己；这里没有外部 SQL 输入。
    if (params.action === "queryRaw" && params.args?.[0] === busyTimeoutPragma) {
      return next(params);
    }
    await initialize();
    return next(params);
  });
  client.$connect = initialize;

  // MUST INITIALIZE BEFORE OPENING A TRANSACTION: 事务先占住 SQLite 连接再等待 PRAGMA 会造成自锁。
  const transaction = client.$transaction.bind(client) as (...args: unknown[]) => Promise<unknown>;
  client.$transaction = ((...args: unknown[]) =>
    initialize().then(() => transaction(...args))) as PrismaClient["$transaction"];
  client.$disconnect = async () => {
    await disconnect();
    initialized = undefined;
  };
  return client;
}

const globalForPrisma = global as unknown as { prisma: PrismaClient | undefined };
export const prisma = globalForPrisma.prisma || createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
