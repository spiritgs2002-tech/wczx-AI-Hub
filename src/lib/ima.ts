/**
 * 腾讯 ima 知识库开放接口（服务端专用）
 *
 * 为什么：老师的资料大多已整理在 ima 知识库里，希望课堂直接引用，不必再导出、上传一遍（2026-11-12 用户需求）。
 * 📐 CONTRACT（来源：ima 官方 skill 包 ima-skills-1.1.2 的 knowledge-base/references/api.md）：
 *   - 只发往 https://ima.qq.com/openapi/wiki/v1/<接口>，HTTP POST + JSON；
 *   - 鉴权 Header：ima-openapi-clientid / ima-openapi-apikey（在 https://ima.qq.com/agent-interface 获取）；
 *   - 统一返回 { code, msg, data }，code=0 时读取 data，code≠0 时把 msg 给用户看；
 *   - 兼容历史格式 { retcode, errmsg, data }，优先读取 code/msg；
 *   - 官方业务错误码为 110001 等六位数，HTTP 200 不是业务错误码；
 *   - 游标翻页：cursor 首次传 ""，is_end=false 时用 next_cursor 继续。
 *   - search_knowledge_base 的 limit 为 1–20；get_knowledge_list 的 limit 为 1–50。
 *   - search_knowledge_base 线上返回 kb_id/kb_name，兼容文档中的 id/name。
 * ⚠️ GOTCHA：ima 知识库接口**没有获取文件全文**的能力，只能 search_knowledge 拿到标题 + 高亮片段（highlight_content）。
 *   所以课堂引用 ima 知识库 = 学生每次提问时实时检索片段喂给 AI（RAG），而不是像本地知识库那样整段拼进提示词。
 * ⛔ DO NOT 把凭证下发到浏览器、写进日志或发往 ima.qq.com 以外的地址。
 * 🔗 RELATED：prisma SystemConfig.imaClientId/imaApiKey、LearningTask.imaKnowledgeBases；
 *   src/app/api/ima/*（教师端代理）；src/app/api/chat/route.ts（对话时检索）；知识仓库页 / 课堂编辑页的 ima 栏。
 */
import { prisma } from "@/lib/prisma";

// IMA_API_BASE 仅供自动化测试指向模拟服务；生产环境不要设置（凭证只应发往 ima.qq.com）
const IMA_BASE = process.env.IMA_API_BASE || "https://ima.qq.com/openapi/wiki/v1";
const TIMEOUT_MS = 8000;

export type ImaCredentials = { clientId: string; apiKey: string };
export type ImaKnowledgeBase = { id: string; name: string; cover_url?: string };
export type ImaKnowledgeRef = { id: string; name: string };
export type ImaItem =
  | { kind: "file"; media_id: string; title: string; parent_folder_id?: string }
  | { kind: "folder"; folder_id: string; name: string; file_number?: number; folder_number?: number };
export type ImaSearchHit = { media_id?: string; title: string; snippet: string; folder_id?: string };

export class ImaError extends Error {
  constructor(message: string, public retcode?: number) {
    super(message);
    this.name = "ImaError";
  }
}

export async function getImaCredentials(): Promise<ImaCredentials | null> {
  const config = await prisma.systemConfig.findFirst({ select: { imaClientId: true, imaApiKey: true } });
  const clientId = config?.imaClientId?.trim();
  const apiKey = config?.imaApiKey?.trim();
  return clientId && apiKey ? { clientId, apiKey } : null;
}

async function call<T>(creds: ImaCredentials, path: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${IMA_BASE}/${path}`, {
      method: "POST",
      headers: {
        "ima-openapi-clientid": creds.clientId,
        "ima-openapi-apikey": creds.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new ImaError((e as Error)?.name === "AbortError" ? "连接 ima 超时，请检查网络" : "无法连接 ima，请检查网络");
  } finally {
    clearTimeout(timer);
  }
  let json: { code?: number; msg?: string; retcode?: number; errmsg?: string; data?: T };
  try {
    json = await res.json();
  } catch {
    throw new ImaError(`ima 返回异常（HTTP ${res.status}）`);
  }
  // ⛔ DO NOT REVERT: 官方响应没有 retcode 时仍可成功；_shared.ts 继续从 ImaError.retcode 取业务码。
  const code = json.code ?? json.retcode;
  const msg = json.msg ?? json.errmsg;
  if (code !== 0) {
    throw new ImaError(msg || `ima 接口错误（${code ?? res.status}）`, code);
  }
  return (json.data ?? {}) as T;
}

/** 去掉高亮片段里的 HTML 标签（如 <em>），压缩空白 */
function cleanSnippet(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** 列出当前账号可见的全部知识库（search_knowledge_base 传空 query 即列出全部；最多翻 10 页） */
export async function listImaKnowledgeBases(creds: ImaCredentials, query = ""): Promise<ImaKnowledgeBase[]> {
  const out: ImaKnowledgeBase[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const data = await call<{
      info_list?: Array<{ id?: string; name?: string; kb_id?: string; kb_name?: string; cover_url?: string }>;
      is_end?: boolean;
      next_cursor?: string;
    }>(creds, "search_knowledge_base", { query, cursor, limit: 20 });
    // ⛔ DO NOT REVERT: 线上字段优先；前端列表和后续请求均依赖有效的 id。
    for (const k of data.info_list || []) {
      const id = k.kb_id ?? k.id;
      const name = k.kb_name ?? k.name;
      if (!id) continue;
      out.push({ id, name: name || id, cover_url: k.cover_url });
    }
    if (data.is_end !== false || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}

/** 浏览知识库（或其中某个文件夹）的一页内容 */
export async function listImaItems(
  creds: ImaCredentials,
  knowledgeBaseId: string,
  folderId?: string,
  cursor = "",
): Promise<{ items: ImaItem[]; nextCursor: string; isEnd: boolean; path: { folder_id: string; name: string }[] }> {
  const data = await call<{
    knowledge_list?: Array<Record<string, unknown>>;
    is_end?: boolean;
    next_cursor?: string;
    current_path?: Array<{ folder_id: string; name: string }>;
  }>(creds, "get_knowledge_list", {
    cursor,
    limit: 50,
    knowledge_base_id: knowledgeBaseId,
    ...(folderId ? { folder_id: folderId } : {}),
  });
  const items: ImaItem[] = (data.knowledge_list || []).map((r) =>
    r.folder_id
      ? { kind: "folder", folder_id: String(r.folder_id), name: String(r.name ?? ""), file_number: Number(r.file_number ?? 0), folder_number: Number(r.folder_number ?? 0) }
      : { kind: "file", media_id: String(r.media_id ?? ""), title: String(r.title ?? ""), parent_folder_id: r.parent_folder_id ? String(r.parent_folder_id) : undefined },
  );
  return {
    items,
    nextCursor: data.next_cursor || "",
    isEnd: data.is_end !== false,
    path: (data.current_path || []).map((p) => ({ folder_id: p.folder_id, name: p.name })),
  };
}

/** 在某个知识库内搜索，返回标题 + 去标签后的高亮片段 */
export async function searchImaKnowledge(
  creds: ImaCredentials,
  knowledgeBaseId: string,
  query: string,
  timeoutMs = TIMEOUT_MS,
): Promise<ImaSearchHit[]> {
  const data = await call<{ info_list?: Array<Record<string, unknown>> }>(
    creds, "search_knowledge", { query, cursor: "", knowledge_base_id: knowledgeBaseId }, timeoutMs,
  );
  return (data.info_list || []).map((r) => ({
    media_id: r.media_id ? String(r.media_id) : undefined,
    folder_id: r.folder_id ? String(r.folder_id) : undefined,
    title: String(r.title ?? r.name ?? ""),
    snippet: cleanSnippet(String(r.highlight_content ?? "")),
  }));
}

export function parseImaRefs(json: string | null | undefined): ImaKnowledgeRef[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.id === "string" && x.id).map((x) => ({ id: x.id, name: String(x.name || x.id) }))
      : [];
  } catch {
    return [];
  }
}

/**
 * 学生对话用：并行检索课堂绑定的 ima 知识库，拼成可追加到系统提示词的参考资料段。
 * ⚠️ GOTCHA：检索失败 / 超时 / 未配置凭证都静默返回空串 —— ima 不可用时不能拖垮正常对话。
 *   总超时 4 秒、最多 8 条、合计约 4000 字，避免挤占模型上下文。
 */
export async function buildImaContext(refsJson: string | null | undefined, question: string): Promise<string> {
  const refs = parseImaRefs(refsJson);
  const q = question.trim().slice(0, 200);
  if (!refs.length || !q || q === "(发送了语音)") return "";
  const creds = await getImaCredentials().catch(() => null);
  if (!creds) return "";
  const results = await Promise.allSettled(refs.map((r) => searchImaKnowledge(creds, r.id, q, 4000)));
  const lines: string[] = [];
  let total = 0;
  results.forEach((res, i) => {
    if (res.status !== "fulfilled") {
      console.warn(`[ima] 检索知识库「${refs[i].name}」失败：`, (res.reason as Error)?.message);
      return;
    }
    for (const hit of res.value) {
      if (lines.length >= 8 || total > 4000) return;
      if (!hit.snippet && !hit.title) continue;
      const line = `- 【${refs[i].name}｜${hit.title}】${hit.snippet}`;
      lines.push(line);
      total += line.length;
    }
  });
  if (!lines.length) return "";
  return (
    `\n## ima 知识库检索结果（与学生本次提问相关的资料片段，仅供参考，请结合课堂目标使用）：\n` +
    lines.join("\n") +
    "\n"
  );
}
