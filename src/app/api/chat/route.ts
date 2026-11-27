import { NextRequest } from "next/server";
import { streamText } from "ai";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";
import { createDashScopeClient } from "@/lib/ai";
import { transcribeAudioWithOmni } from "@/lib/asr";
import { buildImageInjection, MERMAID_HINT } from "@/lib/image-library";
import { aiQueue } from "@/lib/ai-queue";
import { buildImaContext } from "@/lib/ima";
import { dbWrite } from "@/lib/db-queue";
import {
  getClassPromptByStrategy,
  IMAGE_NOTICE,
  MATERIAL_CONTENT_PREFIX,
  replaceConversationVars,
  type ConversationTemplateVars,
} from "@/lib/prompts";
import { MATH_OUTPUT_RULES } from "@/lib/math-format";

// 流内「已切换模型」标记：主模型失败切备用成功后，作为流的首个数据块发给前端；
// 前端（src/app/student/chat/page.tsx）识别后显示「正在切换模型」提示，并从正文中剥离（不入库）。
const SWITCH_PREFIX = "\u0000SWITCH\u0000";

// 多模态消息内容类型
type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } };

type MessageContent = string | MessageContentPart[];

interface ChatMessage {
  role: string;
  content: MessageContent;
}

// 从消息内容中提取纯文本（用于存储到数据库和关键词匹配）
function extractTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

// 检查消息是否包含图片
function hasImageContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((part) => part.type === "image_url");
}

// 检查消息是否包含音频
function hasAudioContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((part) => part.type === "audio_url");
}

/** mediaType（如 audio/wav）→ 文件扩展名（wav/mp3/m4a/ogg/webm，未知回退 audio） */
function mediaTypeToExt(mediaType: string): string {
  const m = mediaType.toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("m4a") || m.includes("mp4")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  return "audio";
}

// 判断消息是否为多模态消息（图片 / 音频）
function isMultimodalContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((part) => part.type === "image_url" || part.type === "audio_url");
}

// 按线路记住模型报出的输出上限（"Range of max tokens should be [1, N]"），后续请求直接用 N，免得每次先失败一回。
// ⚠️ GOTCHA：换模型后旧上限仍生效直到重启服务；它只会让输出上限偏小，不会导致失败，可接受。
const learnedMaxTokens: Record<string, number> = {};

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return new Response("未登录", { status: 401 });
    }

    const payload = await verifyToken(token);
    if (!payload) {
      return new Response("登录已过期", { status: 401 });
    }

    const { messages, conversationId, classId, presetConversationId } = await req.json();
    const lastMessage: ChatMessage = messages[messages.length - 1];
    const userId = String(payload.userId);
    let textContent = extractTextContent(lastMessage.content);

    // 语音转写（2026-10-15 需求）：纯语音消息（文字为占位符"(发送了语音)"）用全媒体模型
    // 转写为文字，存库后记录既能看文字又能播音频；分析链路只取文字。
    // ⛔ DO NOT REVERT 成「等转写完再回复」：转写是一次完整的模型调用，原先 await 在回复之前，
    //   语音回复要串行等两次模型（2026-11-12 平板反馈"语音反应慢"）。现在回复立即开始（模型直接"听"原声），
    //   转写在后台完成后再回写用户消息文字与新对话标题；失败保留占位符。
    // 🔗 RELATED：下方「写操作 2」之后的 transcribePromise.then 回写。
    const transcribePromise =
      typeof lastMessage.content !== "string" &&
      lastMessage.content.some((p) => p.type === "audio_url") &&
      textContent.trim() === "(发送了语音)"
        ? transcribeAudioWithOmni(lastMessage.content)
        : Promise.resolve(null);

    // 如果没有 conversationId，自动创建新的 Conversation（写操作走队列）
    let convId = conversationId;
    const needCreate = !convId;

    // 读查询并行（无数据依赖）
    const classDataPromise = prisma.class.findUnique({
      where: { id: classId },
    });

    // 当前对话学生（用于 {studentName} 变量替换，让 AI 能叫出学生姓名）
    const currentUserPromise = prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, classId: true },
    });

    const materialsPromise = prisma.material.findMany({
      where: { classId, type: "LEARNING" },
      include: { DocumentChunk: true },
    });

    const presetConvPromise = presetConversationId
      ? prisma.presetConversation.findUnique({
          where: { id: presetConversationId },
          include: {
            SubProject: { include: { task: true } },
          },
        })
      : Promise.resolve(null);

    // 等待读查询完成，再决定写操作
    const [classData, materials, presetConv, currentUser] = await Promise.all([
      classDataPromise,
      materialsPromise,
      presetConvPromise,
      currentUserPromise,
    ]);

    if (!classData) {
      return new Response("班级不存在", { status: 404 });
    }

    // MUST VALIDATE CLIENT IDS: classId / conversationId / presetConversationId 都来自前端，必须核对归属后才能使用。
    // 为什么：原先直接信任这三个参数 —— 学生可往别人的对话里写消息、读取他班学习资料、使用已停用的对话活动（2026-11-27 审核发现）。
    // 📐 CONTRACT：
    //   - 学生：classId 必须是本人当前班级；教师：classId 必须是本人的班级（预览/调试场景）。
    //   - conversationId 必须属于本人且属于该班级。
    //   - 学生使用 presetConversationId 时：活动需启用、所属课堂启用且已布置给该班级。
    // 🔗 RELATED：src/app/student/chat/page.tsx 调用处；src/app/api/student/explorations/[id]/route.ts 同类布置校验。
    // ⛔ DO NOT REVERT：校验必须在任何写库（创建对话 / 保存消息）之前执行。
    const isTeacher = payload.role === "TEACHER";
    if (isTeacher ? classData.teacherId !== userId : currentUser?.classId !== classId) {
      return new Response("无权访问该班级", { status: 403 });
    }
    if (conversationId) {
      const ownConv = await prisma.conversation.findFirst({
        where: { id: conversationId, userId, classId },
        select: { id: true },
      });
      if (!ownConv) return new Response("对话不存在", { status: 404 });
    }
    if (presetConversationId) {
      if (!presetConv) return new Response("对话活动不存在", { status: 404 });
      const pcTask = presetConv.SubProject.task;
      if (isTeacher) {
        if (pcTask.teacherId !== userId) return new Response("对话活动不存在", { status: 404 });
      } else {
        const assigned = await prisma.taskAssignment.findFirst({
          where: { taskId: pcTask.id, classId },
          select: { id: true },
        });
        if (!assigned || pcTask.status !== "ENABLED" || presetConv.enabled === false) {
          return new Response("对话活动未开放", { status: 403 });
        }
      }
    }


    // 写操作 1：创建新对话（如需要）
    let createConvResult: { id: string } | null = null;
    if (needCreate) {
      createConvResult = await dbWrite(() =>
        prisma.conversation.create({
          data: {
            userId,
            classId,
            presetConversationId: presetConversationId || null,
            title: textContent.slice(0, 50) || "图片对话",
            updatedAt: new Date(),
          },
        })
      );
      convId = createConvResult.id;

      // 写操作 1.5：新会话预置教师开场白（assistant 首条消息，2026-10-13）。
      // ⚠️ 仅 needCreate（新会话）写入一次，复用旧会话不重复插入；
      // 前端首条发言的 apiMessages 已把开场白拼进上下文（见 student/chat sendMessage），两侧口径一致。
      if (presetConv?.openingMessage) {
        await dbWrite(() =>
          prisma.message.create({
            data: {
              conversationId: convId!,
              role: "assistant",
              content: presetConv.openingMessage!,
            },
          })
        );
      }
    }

    // 写操作 2：保存用户消息（依赖 convId 已确定）
    // 多模态消息把完整 JSON 存下来，刷新后仍能显示图片 / 音频
    const savedUserMessage = await dbWrite(() =>
      prisma.message.create({
        data: {
          conversationId: convId!,
          role: "user",
          content: isMultimodalContent(lastMessage.content)
            ? JSON.stringify(lastMessage.content)
            : textContent,
        },
      })
    );

    // 后台回写转写文字：不阻塞下方 AI 回复（音频 part 保留，刷新后既能看文字又能播原声）
    const savedContent = lastMessage.content;
    const createdConvId = needCreate ? convId! : null;
    void transcribePromise
      .then(async (transcribed) => {
        if (!transcribed || typeof savedContent === "string") return;
        const withText = savedContent.map((p) => (p.type === "text" ? { ...p, text: transcribed } : p));
        await dbWrite(() =>
          prisma.message.update({ where: { id: savedUserMessage.id }, data: { content: JSON.stringify(withText) } })
        );
        if (createdConvId) {
          await dbWrite(() =>
            prisma.conversation.update({ where: { id: createdConvId }, data: { title: transcribed.slice(0, 50) } })
          );
        }
      })
      .catch((e) => console.warn("[asr] 转写回写失败：", e instanceof Error ? e.message : e));

    let systemPrompt = "";

    if (presetConv) {
      const task = presetConv.SubProject.task;

      // 构建对话活动的系统提示：教师模板变量替换 + 知识库自动追加（与学情分析一致）
      const vars: ConversationTemplateVars = {
        pcTitle: presetConv.title,
        pcDescription: presetConv.description || "",
        activeCount: 0,
        totalStudents: 0,
        studentName: currentUser?.name || "",
        taskTitle: task.title,
        taskDescription: task.objectives || "",
        taskGrade: task.grade || "",
        taskSubject: task.subject || "",
      };

      const teacherTemplate = presetConv.systemPrompt || "";

      // 1. 教师对话提示词运行时变量替换（isStudent=true 注入学生姓名）
      systemPrompt = replaceConversationVars(teacherTemplate, vars, true);

      // 2. 兜底：教师模板未引用任何课堂信息变量时，自动追加基础课堂信息
      const hasTaskInfo = /\{taskTitle\}|\{taskGrade\}|\{taskSubject\}|\{taskDescription\}|\{taskObjectives\}/.test(
        teacherTemplate
      );
      if (!hasTaskInfo) {
        systemPrompt =
          `## 当前课堂：${task.title}\n` +
          `年级：${task.grade || ''}  学科：${task.subject || ''}\n` +
          `课堂目标：${task.objectives || ''}\n\n` +
          systemPrompt;
      }

      // 3. 知识库（课堂级，数据内容由软件自动追加）
      if (task.knowledgeBase) {
        systemPrompt += `\n## 课堂知识库：\n${task.knowledgeBase}\n`;
      }
      if (task.knowledgeBaseIds) {
        try {
          const kbIds = JSON.parse(task.knowledgeBaseIds) as string[];
          if (kbIds.length > 0) {
            const knowledgeBases = await prisma.knowledgeBase.findMany({
              where: { id: { in: kbIds }, teacherId: task.teacherId },
            });
            for (const kb of knowledgeBases) {
              systemPrompt += `\n## 知识库「${kb.name}」：\n${kb.content}\n`;
            }
          }
        } catch {
          // knowledgeBaseIds 解析失败，忽略
        }
      }

      // 3.2 ima 知识库（课堂绑定，2026-11-12）：按学生本次提问实时检索片段追加到提示词。
      // ⚠️ GOTCHA：ima 无全文接口，只能检索片段；失败/超时（4 秒）静默跳过，不影响正常对话。
      //   纯语音消息此刻文字仍是占位符（转写在后台），本轮不检索。
      // 🔗 RELATED：src/lib/ima.ts buildImaContext；课堂编辑页「引用 ima 知识库」。
      if (task.imaKnowledgeBases) {
        systemPrompt += await buildImaContext(task.imaKnowledgeBases, textContent);
      }

      // 3.5 图片组（课堂级，AI 可在回复中用 Markdown 图片语法发送组内图片）
      try {
        const imageInjection = await buildImageInjection(
          task.imageGroupIds,
          task.teacherId
        );
        if (imageInjection) {
          systemPrompt += imageInjection;
        }
      } catch {
        // 图片组注入失败，忽略（不影响对话）
      }

      // 3.6 Mermaid 示意图能力（前端 Markdown 组件渲染 ```mermaid 代码块）
      systemPrompt += MERMAID_HINT;

      // 4. 兜底：教师模板未引用 {pcDescription} 时，自动追加对话目标
      if (presetConv.description && !/\{pcDescription\}/.test(teacherTemplate)) {
        systemPrompt += `\n对话目标：${presetConv.description}\n`;
      }
    } else {
      // 无对话活动，使用原有班级策略
      const strategyPrompt = getClassPromptByStrategy(
        classData.aiPromptStrategy,
        classData.customSystemPrompt ?? undefined
      );
      systemPrompt = strategyPrompt ? `${strategyPrompt}\n\n` : "";

      // 学习材料：全量注入（材料总量通常不大）
      const allChunks = materials.flatMap((m) => m.DocumentChunk);
      if (allChunks.length > 0) {
        systemPrompt += `${MATERIAL_CONTENT_PREFIX}\n`;
        allChunks.forEach((chunk, i) => {
          systemPrompt += `[片段${i + 1}] ${chunk.content}\n`;
        });
      }

      // Mermaid 示意图能力（前端 Markdown 组件渲染 ```mermaid 代码块）
      systemPrompt += MERMAID_HINT;
    }

    // 如果消息包含图片，提示 AI 可以分析图片
    if (hasImageContent(lastMessage.content)) {
      systemPrompt += `\n${IMAGE_NOTICE}\n`;
    }

    // 统一数学公式输出格式：要求模型使用 $...$ / $$...$$ 定界符，
    // 否则模型可能输出 \(...\) / \[...\]，前端会当作普通文本，学生看到 LaTeX 源码
    systemPrompt += `\n\n${MATH_OUTPUT_RULES}`;

    // 双线路路由：含语音/音频的消息走全媒体线路（omni），否则走图文线路（text）
    // ⚠️ GOTCHA: 线路只看最新一条消息。第二轮纯文字会切到 text 线路，但历史里第一条
    //   语音消息仍带 file(音频) part —— provider 会转成 input_audio 发给图文模型，
    //   实测报 "Failed to deserialize ... unknown variant input_audio"（2026-10-15）。
    //   因此 text 线路必须在构建消息时剥离历史音频 part（见下方 filter，图片保留）。
    const isOmniRoute = hasAudioContent(lastMessage.content);
    // 切备事件上报：主失败切备用成功后，向流内注入「正在切换模型」标记
    // （streamController 在流的 start() 中才赋值，onFailover 晚于此时触发，闭包可安全引用）
    const { chatModel } = await createDashScopeClient(
      isOmniRoute ? "omni" : "text",
      {
        onFailover: () => {
          if (!switchNoticeSent && streamController) {
            switchNoticeSent = true;
            streamController.enqueue(encoder.encode(SWITCH_PREFIX));
          }
        },
      }
    );

    // 构建消息格式，支持多模态
    // ⛔ DO NOT REVERT: text 线路（isOmniRoute=false）剥离历史 audio part。
    //   历史教训：2026-10-15 语音后第二轮输入文字，带音频的历史消息被原样发给
    //   图文模型（DeepSeek），其不认识 input_audio，请求整体失败。剥离后纯文字
    //   轮次正常；语音轮次（omni）仍完整保留音频上下文。
    const formattedMessages = messages.map((m: ChatMessage) => {
      if (typeof m.content === "string") {
        return { role: m.role as "user" | "assistant", content: m.content };
      }
      // 多模态消息：将 image_url / audio_url 转为 ai v6 SDK 的多模态格式
      // ⛔ DO NOT REVERT：omni 线路也只保留「最新一条消息」的音频，历史语音只发其转写文字。
      // 为什么：2026-11-12 一个对话里累积 7 条语音，每轮把全部历史音频（约 1MB base64）发给
      //   qwen omni，网关报 "The provided URL does not appear to be valid"；同格式的单条音频（ASR 转写）却成功。
      //   历史语音的文字已由 ASR 写回消息 text，上下文不丢。
      // 🔗 RELATED：src/lib/asr.ts（转写写回）；上方 text 线路剥离历史音频的同类教训。
      const parts = m.content
        .filter((part) => part.type !== "audio_url" || (isOmniRoute && m === lastMessage))
        .map((part) => {
        if (part.type === "image_url") {
          const url = part.image_url.url;
          // 如果是 Base64 data URL，提取编码数据
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
            if (match) {
              return {
                type: "image" as const,
                image: match[2], // 纯 base64 字符串
                mediaType: match[1],
              };
            }
          }
          // 如果是 URL 图片
          return {
            type: "image" as const,
            image: url,
            mediaType: "image/jpeg",
          };
        }
        if (part.type === "audio_url") {
          const url = part.audio_url.url;
          // 如果是 Base64 data URL，提取编码数据
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(audio\/[\w.+-]+);base64,(.+)$/);
            if (match) {
              return {
                type: "file" as const,
                data: match[2], // 纯 base64 字符串
                mediaType: match[1],
                filename: `audio-${Date.now()}.${mediaTypeToExt(match[1])}`,
              };
            }
          }
          // 如果是 URL 音频
          return {
            type: "file" as const,
            data: url,
            mediaType: "audio/mpeg",
            filename: "audio.mp3",
          };
        }
        return { type: "text" as const, text: part.text };
      });
      return { role: m.role as "user" | "assistant", content: parts };
    });

    const finalConvId = convId;
    const encoder = new TextEncoder();
    // 切备事件注入「正在切换模型」标记所需：控制器在 start() 中赋值，onFailover 回调晚于此时触发
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let switchNoticeSent = false;

    const stream = new ReadableStream({
      async start(controller) {
        streamController = controller;
        let fullContent = "";
        let chunkCount = 0;
        let streamError: Error | null = null;

        // 单次流式请求。AI SDK v6 在 429 限流/403 配额等错误时 for-await 不抛异常、
        // 流为空，必须借 onError 回调才能拿到真实错误（与 exploration ai-chat 路由同款防护）
        // ⚠️ GOTCHA：输出上限默认 64K，但部分模型（如 omni、deepseek-flash）上限更低，网关报
        //   "Range of max tokens should be [1, N]"。首次失败后按报错里的 N 自动降级重试（2026-11-12 omni 实测）。
        const routeKey = isOmniRoute ? "omni" : "text";
        let maxOutputTokens = learnedMaxTokens[routeKey] ?? 65536;
        const runStream = async () => {
          const result = await aiQueue.enqueue(async () => {
            return streamText({
              model: chatModel,
              system: systemPrompt,
              messages: formattedMessages,
              // 统一输出上限 64K（网关默认 4096 会截断长输出，实测硬上限 65536）
              maxOutputTokens,
              onError: ({ error }: { error: unknown }) => {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error("[chat] streamText onError:", errMsg);
                streamError = error instanceof Error ? error : new Error(errMsg);
              },
            });
          });

          for await (const chunk of result.textStream) {
            chunkCount++;
            fullContent += chunk;
            controller.enqueue(encoder.encode(chunk));
          }
          await result.consumeStream();

          // 空流时记录结束原因，便于区分限流/内容审核/截断
          if (chunkCount === 0) {
            try {
              const reason = await Promise.race([
                result.finishReason,
                new Promise<string>((r) => setTimeout(() => r("未知（获取超时）"), 2000)),
              ]);
              console.warn("[chat] 流为空，finishReason:", reason);
            } catch {}
          }
        };

        try {
          await runStream();

          // 空流自动重试一次：此时客户端尚未收到任何内容，重试无副作用；
          // 偶发的限流（429）/网关抖动导致的空流，重试大概率恢复
          if (chunkCount === 0) {
            const limit = (streamError as Error | null)?.message.match(/max.?tokens[^\[]*\[\s*1\s*,\s*(\d+)\s*\]/i);
            if (limit) {
              maxOutputTokens = Number(limit[1]);
              learnedMaxTokens[routeKey] = maxOutputTokens;
              console.warn(`[chat] 模型输出上限为 ${maxOutputTokens}，按此上限重试`);
            } else {
              console.warn("[chat] AI 返回空流，自动重试一次");
            }
            streamError = null;
            await runStream();
          }

          // 重试后仍为空：按真实原因提示，不再一律归咎于图片输入
          if (chunkCount === 0) {
            // streamError 仅在 onError 回调内赋值，控制流分析会把它收窄为 null，需断言
            const raw = (streamError as Error | null)?.message || "";
            let errMsg: string;
            if (raw) {
              // ⛔ DO NOT REVERT: 本项目 streamText 固定 maxOutputTokens=65536（见下方调用处），
              // 部署点若配了输出上限 <64K 的模型（如 deepseek-flash 上限 32768），网关返回
              // 400 InternalError.Algo.InvalidParameter: "Range of max tokens should be [1, 32768]"，
              // 原样透传学生看不懂（2026-10-21 课堂实测）→ 必须译成人话并给行动指引。
              // 🔗 RELATED: src/app/api/exploration-activities/[id]/ai-chat/route.ts finally 段有同款分支，两处须同步。
              // ⚠️ GOTCHA: 全媒体线路若配成不支持音频的模型（如 DeepSeek），网关报
              //   "unknown variant `input_audio`"，原样透传学生看不懂（2026-11-12 平板实测）→ 译成人话并告诉老师怎么改。
              errMsg = hasAudioContent(lastMessage.content) && /input_audio|audio/i.test(raw)
                ? "当前 AI 模型不支持语音输入。请老师在「系统设置 → AI 服务配置 → 全媒体线路」填写支持语音的模型（如阿里百炼 qwen3.8-omni-flash）；你也可以先改用文字提问。"
                : /max.?tokens|InvalidParameter/i.test(raw)
                ? "AI 模型输出上限设置超限，请联系老师，更换 64K 及以上大模型。"
                : /quota|配额|free|429|rate|limit/i.test(raw)
                ? "AI 服务繁忙（限流或配额不足），请稍后重试"
                : `AI 服务响应异常：${raw.slice(0, 100)}`;
            } else if (hasAudioContent(lastMessage.content)) {
              errMsg = "AI 模型返回了空响应（可能不支持音频输入，请检查模型配置）";
            } else if (hasImageContent(lastMessage.content)) {
              errMsg = "AI 模型返回了空响应（可能不支持图片输入，请检查模型配置）";
            } else {
              errMsg = "AI 模型返回了空响应，请重新发送试试";
            }
            console.error("[chat] Empty stream:", errMsg, raw);
            controller.enqueue(encoder.encode(errMsg));
            fullContent = errMsg;
          }
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : "AI 响应出错";
          console.error("Stream/API error:", errMsg);
          controller.enqueue(encoder.encode(`\n\n**AI 响应出错**：${errMsg}`));
          fullContent += `\n\n**AI 响应出错**：${errMsg}`;
        } finally {
          controller.close();
          if (fullContent) {
            try {
              await dbWrite(() =>
                prisma.message.create({
                  data: {
                    conversationId: finalConvId,
                    role: "assistant",
                    content: fullContent,
                  },
                })
              );
              await dbWrite(() =>
                prisma.conversation.update({
                  where: { id: finalConvId },
                  data: { updatedAt: new Date() },
                })
              );
            } catch (dbError) {
              console.error("Save AI reply error:", dbError);
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Conversation-Id": finalConvId,
        // 本次回复所用线路：前端据此在学生端显示「图文/全媒体模型」指示点（绿=图文 text、黑=全媒体 omni）。
        // 用响应头而非流内标记：前端 fetch 后读一次即可，避免流解析跨 chunk 剥离的复杂度。
        "X-Model-Route": isOmniRoute ? "omni" : "text",
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "对话失败";
    console.error("Chat error:", errMsg, error instanceof Error ? error.stack : "");
    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
