import { BM25Index } from "./bm25";
import { chunkText } from "./chunker";

// MUST KEEP CHAT PROMPTS SHORT: AI 对话每条消息都会重新发送系统提示词，知识库/学习材料全文拼进去后，
//   提示词可达数万字，模型首字等待明显变长（2026-11-27 性能排查）。
// 现状：资料总量不超过 KNOWLEDGE_FULL_LIMIT 时仍全文注入（小资料不丢信息）；超过时按学生最近提问
//   用 BM25 检索相关片段，总长不超过 KNOWLEDGE_RETRIEVE_BUDGET；检索不到时取各资料开头片段兜底。
// 📐 CONTRACT: 输出片段保持资料原有顺序（同一资料内按位置），不打乱上下文。
// 🔗 RELATED: src/app/api/chat/route.ts（课堂知识库、知识库、学习材料三处注入）；src/lib/bm25.ts。
// ⛔ DO NOT REVERT 成「每次全文注入」：资料一多，学生每发一条消息都要等模型读完全部资料。
export const KNOWLEDGE_FULL_LIMIT = 8000;
export const KNOWLEDGE_RETRIEVE_BUDGET = 6000;
const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 100;

export type KnowledgeSource = {
  /** 资料名，用于输出分组标题 */
  title: string;
  /** 资料全文；与 passages 二选一 */
  content?: string;
  /** 已切好的片段（如学习材料的 DocumentChunk）；给出时不再切分 */
  passages?: string[];
};

export type SelectedKnowledge = { title: string; passages: string[]; full: boolean };

/**
 * 按提问挑选要注入提示词的资料片段。
 * @param query 学生最近的提问文字（可拼接上一条提问，便于理解「那第二个呢」这类追问）
 */
export function selectKnowledge(
  sources: KnowledgeSource[],
  query: string,
  opts: { fullLimit?: number; budget?: number } = {}
): SelectedKnowledge[] {
  const fullLimit = opts.fullLimit ?? KNOWLEDGE_FULL_LIMIT;
  const budget = opts.budget ?? KNOWLEDGE_RETRIEVE_BUDGET;

  const normalized = sources
    .map((s) => ({
      title: s.title,
      passages: (s.passages ?? (s.content ? [s.content] : [])).map((p) => p.trim()).filter(Boolean),
    }))
    .filter((s) => s.passages.length > 0);

  const total = normalized.reduce((sum, s) => sum + s.passages.reduce((n, p) => n + p.length, 0), 0);
  if (total <= fullLimit) {
    return normalized.map((s) => ({ ...s, full: true }));
  }

  // 统一切成小片段（已是片段的长段落也再切，避免单段超出预算）
  type Piece = { sourceIdx: number; order: number; text: string };
  const pieces: Piece[] = [];
  normalized.forEach((s, sourceIdx) => {
    let order = 0;
    for (const p of s.passages) {
      for (const text of chunkText(p, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP })) {
        pieces.push({ sourceIdx, order: order++, text });
      }
    }
  });

  const index = new BM25Index();
  pieces.forEach((p, i) => index.addDoc(i, p.text));
  let ranked = index.search(query, pieces.length).map((r) => pieces[r.id as number]);

  // 检索不到（如纯语音、寒暄）：轮流取各资料开头的片段兜底
  if (ranked.length === 0) {
    const bySource = normalized.map((_, i) => pieces.filter((p) => p.sourceIdx === i));
    const maxLen = Math.max(...bySource.map((b) => b.length));
    ranked = [];
    for (let k = 0; k < maxLen; k++) for (const b of bySource) if (b[k]) ranked.push(b[k]);
  }

  const picked: Piece[] = [];
  let used = 0;
  for (const p of ranked) {
    if (used + p.text.length > budget) {
      if (picked.length === 0) { picked.push({ ...p, text: p.text.slice(0, budget) }); }
      break;
    }
    picked.push(p);
    used += p.text.length;
  }

  return normalized
    .map((s, sourceIdx) => ({
      title: s.title,
      full: false,
      passages: picked
        .filter((p) => p.sourceIdx === sourceIdx)
        .sort((a, b) => a.order - b.order)
        .map((p) => p.text),
    }))
    .filter((s) => s.passages.length > 0);
}
