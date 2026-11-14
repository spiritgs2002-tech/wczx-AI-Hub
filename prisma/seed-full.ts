import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { initializeDefaultTemplates } from "../src/lib/initialize-default-templates";
import { seedInitialClass } from "./seed-initial";

const prisma = new PrismaClient();

// 系统配置的期望值（不含 AI 配置：API Key 由用户在【系统设置】中自行填写，seed 不覆盖）
const SYSTEM_CONFIG = {
  insightDataSource: "CONVERSATIONS",
  requireStarRating: false,
  studentWordLimit: 100,
  classWordLimit: 2005,
  reasoningEnabled: true,
  teacherName: "管老师",
  grade: "七年级",
  subject: "数学",
  conversationWarningThreshold: 20000,
};

// 仅首次创建时的 AI 默认值（不含 API Key，用户需在系统设置中配置）
const AI_DEFAULTS = {
  aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  aiApiKey: null as string | null,
  aiModel: "qwen3-35b-a3b",
};

/**
 * 同步系统配置（id=system-config-1）
 * 由 npm run db:seed 调用
 * 注意：update 分支不碰 aiBaseUrl/aiApiKey/aiModel，避免覆盖用户已配置的 AI 服务
 */
export async function seedSystemConfig() {
  const config = await prisma.systemConfig.upsert({
    where: { id: "system-config-1" },
    update: { ...SYSTEM_CONFIG, updatedAt: new Date() },
    create: { id: "system-config-1", ...AI_DEFAULTS, ...SYSTEM_CONFIG, updatedAt: new Date() },
  });
  console.log("系统配置已同步（AI API Key 请在【系统设置】中配置）");
  return config;
}

/**
 * 同步教师专属数据：班级、学生、任务、子项目、预设对话、任务分配、分析模板
 * @param teacherId 已有教师 ID（不创建/更新教师账号）
 * @param teacherName 教师姓名（用于日志）
 *
 * 由 npm run db:seed 调用，或由新教师注册时通过 prisma/seed-demo.ts 间接调用
 */
export async function seedTeacherData(teacherId: string, teacherName: string, includeTemplates = true) {
  // MUST RESTRICT TO DEMO USE: 历史演示数据包含 123456 弱密码账号，不得用于生产初始化。
  // 📐 CONTRACT: 正式首次注册使用 seed-initial.ts；此函数仅供显式开发演示流程。
  // 🔗 RELATED: prisma/seed-demo.ts、src/app/api/auth/register/route.ts。
  // ⛔ DO NOT REVERT: 避免未来把含弱密码的演示账号重新接入生产注册。
  console.log(`开始同步教师 [${teacherName}] 的专属数据...`);

  const hashedPassword = await bcrypt.hash("123456", 10);


  // 3. 班级 - 使用 upsert 基于 inviteCode
  const cls1 = await prisma.class.upsert({
    where: { inviteCode: "MATH2026" },
    update: {
      name: "七年级(1)班",
      description: "七年级第一学期数学实验班",
      teacherId,
      status: "ACTIVE",
      isCurrent: true,
    },
    create: {
      name: "七年级(1)班",
      description: "七年级第一学期数学实验班",
      teacherId,
      inviteCode: "MATH2026",
      status: "ACTIVE",
      aiPromptStrategy: "PRIORITY_MATERIAL",
      isCurrent: true,
    },
  });
  console.log("班级1已同步:", cls1.name);

  const cls2 = await prisma.class.upsert({
    where: { inviteCode: "MATH2026B" },
    update: {
      name: "七年级(2)班",
      description: "七年级第二班",
      teacherId,
      status: "ACTIVE",
      isCurrent: false,
    },
    create: {
      name: "七年级(2)班",
      description: "七年级第二班",
      teacherId,
      inviteCode: "MATH2026B",
      status: "ACTIVE",
      aiPromptStrategy: "PRIORITY_MATERIAL",
      isCurrent: false,
    },
  });
  console.log("班级2已同步:", cls2.name);

  // 4. 学生 - 使用 upsert 基于 email
  const studentData = [
    { name: "张小明", email: "zhang@student.com", studentNo: "2026001", classId: cls1.id },
    { name: "李小红", email: "li@student.com", studentNo: "2026002", classId: cls1.id },
    { name: "王建国", email: "wang@student.com", studentNo: "2026003", classId: cls1.id },
    { name: "陈思思", email: "chen@student.com", studentNo: "2026004", classId: cls1.id },
    { name: "刘洋", email: "liu@student.com", studentNo: "2026005", classId: cls1.id },
    { name: "张伟", email: "zhangwei@student.com", studentNo: "2026006", classId: cls2.id },
    { name: "李四", email: "lisi@student.com", studentNo: "2026007", classId: cls2.id },
    { name: "王五", email: "wangwu@student.com", studentNo: "2026008", classId: cls2.id },
    { name: "赵丽颖", email: "zhaoli@student.com", studentNo: "2026009", classId: cls2.id },
    { name: "王俊凯", email: "wangjunkai@student.com", studentNo: "2026010", classId: cls2.id },
    { name: "张杰", email: "zhangjie@student.com", studentNo: "2026011", classId: cls2.id },
  ];

  for (const s of studentData) {
    const existing = await prisma.user.findFirst({ where: { email: s.email } });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { name: s.name, studentNo: s.studentNo, classId: s.classId },
      });
    } else {
      await prisma.user.create({
        data: {
          email: s.email,
          password: hashedPassword,
          name: s.name,
          studentNo: s.studentNo,
          role: "STUDENT",
          classId: s.classId,
        },
      });
    }
  }
  console.log("学生已同步:", studentData.length, "人");

  // 5. 任务 - 查找或创建（基于标题和教师）
  let task = await prisma.learningTask.findFirst({
    where: { title: "一元一次方程", teacherId },
  });
  if (!task) {
    task = await prisma.learningTask.create({
      data: {
        title: "一元一次方程",
        description: "掌握一元一次方程的概念、解法和应用",
        grade: "七年级",
        subject: "数学",
        objectives:
          "1. 理解一元一次方程的定义\n2. 掌握移项、去括号、去分母的方法\n3. 能够列方程解决实际问题",
        requirements: "认真完成每个对话活动，积极参与讨论",
        status: "ENABLED",
        teacherId,
        updatedAt: new Date(),
      },
    });
    console.log("创建任务: 一元一次方程");
  } else {
    console.log("任务已存在:", task.title);
  }

  // 6. 子项目 - 查找或创建（仅1个，学生端显示为"对话思考"）
  let sp1 = await prisma.subProject.findFirst({
    where: { taskId: task.id, title: "默认活动" },
  });
  if (!sp1) {
    sp1 = await prisma.subProject.create({
      data: {
        taskId: task.id,
        title: "默认活动",
        description: "通过对话、练习和探究活动学习一元一次方程",
        objectives: "理解方程概念，掌握解法，能解决实际问题",
        requirements: "认真完成每个对话活动，积极参与讨论",
        sortOrder: 1,
        enabled: true,
      },
    });
    console.log("创建子项目: 默认活动（学生端显示为对话思考）");
  }

  // 7. 预设对话 - 查找或创建（全部挂在这个子项目下）
  const pcData = [
    {
      subProjectId: sp1.id,
      title: "什么是方程？",
      description: "通过对话帮助你理解方程的基本概念",
      systemPrompt: "你是一位耐心的数学老师，用生动有趣的比喻帮助学生理解方程的概念。",
      sortOrder: 1,
    },
    {
      subProjectId: sp1.id,
      title: "找等量关系",
      description: "练习从实际问题中找出等量关系",
      systemPrompt: "你是一位数学教练，引导学生从生活情境中抽象出等量关系。",
      sortOrder: 2,
    },
    {
      subProjectId: sp1.id,
      title: "移项法则",
      description: "学习解方程的第一步：移项",
      systemPrompt: "你是一位经验丰富的数学教师，用例题讲解移项的原理和注意事项。",
      sortOrder: 3,
    },
  ];

  for (const pc of pcData) {
    const existing = await prisma.presetConversation.findFirst({
      where: { subProjectId: pc.subProjectId, title: pc.title },
    });
    if (!existing) {
      await prisma.presetConversation.create({
        data: {
          subProjectId: pc.subProjectId,
          title: pc.title,
          description: pc.description,
          systemPrompt: pc.systemPrompt,
          sortOrder: pc.sortOrder,
          enabled: true,
        },
      });
      console.log("创建预设对话:", pc.title);
    }
  }

  // 8. 任务分配 - 使用 upsert
  await prisma.taskAssignment.upsert({
    where: { taskId_classId: { taskId: task.id, classId: cls1.id } },
    update: {},
    create: { taskId: task.id, classId: cls1.id },
  });
  await prisma.taskAssignment.upsert({
    where: { taskId_classId: { taskId: task.id, classId: cls2.id } },
    update: {},
    create: { taskId: task.id, classId: cls2.id },
  });
  console.log("任务分配已同步");

  // MUST PRESERVE DEFAULTS: 初始化六类模板时保留教师已有默认选择和正文。
  // 📐 CONTRACT: includeTemplates=false 供注册演示数据使用；注册事务已创建默认模板。
  // 🔗 RELATED: src/lib/initialize-default-templates.ts、src/app/api/auth/register/route.ts。
  // ⛔ DO NOT REVERT: seed 可重复执行，不得覆盖教师修改过的模板。
  if (includeTemplates) {
    await prisma.$transaction((tx) => initializeDefaultTemplates(tx, teacherId));
  }

  return { cls1, cls2, task, sp1 };
}

async function main() {
  console.log("开始同步数据...\n");

  await seedSystemConfig();

  // 教师 - 查找或创建（仅开发者 npm run db:seed 使用）
  const hashedPassword = await bcrypt.hash("123456", 10);
  let teacher = await prisma.user.findFirst({
    where: { role: "TEACHER" },
  });
  if (!teacher) {
    teacher = await prisma.user.create({
      data: {
        email: "teacher@wczx-ai-hub.com",
        password: hashedPassword,
        name: "管老师",
        role: "TEACHER",
      },
    });
    console.log("创建教师: teacher@wczx-ai-hub.com");
  } else {
    teacher = await prisma.user.update({
      where: { id: teacher.id },
      data: { name: "管老师" },
    });
    console.log("教师已存在，已更新信息");
  }

  await prisma.$transaction(async (tx) => {
    await initializeDefaultTemplates(tx, teacher!.id);
    await seedInitialClass(tx, teacher!.id);
  });

  console.log("\n=== 数据统计 ===");
  console.log("用户:", await prisma.user.count());
  console.log("班级:", await prisma.class.count());
  console.log("任务:", await prisma.learningTask.count());
  console.log("子项目:", await prisma.subProject.count());
  console.log("预设对话:", await prisma.presetConversation.count());
  console.log("模板:", await prisma.analysisTemplate.count());
  console.log("任务分配:", await prisma.taskAssignment.count());

  console.log("\n数据同步完成！");
  console.log("登录信息：teacher@wczx-ai-hub.com / 123456");
}

// 仅当直接执行时（npm run db:seed）运行 main()，被导入时不运行
const isMainModule = process.argv[1]?.endsWith("seed-full.ts");
if (isMainModule) {
  main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
