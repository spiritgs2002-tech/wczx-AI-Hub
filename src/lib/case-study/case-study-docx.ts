import { AlignmentType, Document, Footer, ImageRun, Packer, PageNumber, Paragraph, TextRun } from "docx";
import { generateFrameworkDiagram } from "@/lib/research/framework-diagram";
import { CASE_SECTIONS, type CaseStudyContent } from "@/lib/prompts/case-study";

const font = { ascii: "Times New Roman", eastAsia: "宋体" };

// MUST KEEP WORD AVAILABLE: 模式图依赖图片渲染环境，失败时保留结构化文字。
// 📐 CONTRACT: 与课堂预览共用清洗后的正文；🔗 RELATED: case-study route 与 manual-generator.ts。
// ⛔ DO NOT REVERT: 模式图异常不能阻断 Word 下载。
export async function generateCaseStudyDocx(content: CaseStudyContent, themeLabels: string[], warnings: string[] = []): Promise<Buffer> {
  const paragraph = (text: string, size = 24, bold = false, center = false) => new Paragraph({
    children: [new TextRun({ text, font, size, bold })],
    alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: bold ? 160 : 0, after: 120, line: 360 },
  });
  const children = [paragraph(content.title, 36, true, true), paragraph(themeLabels.join("、"), 22, false, true)];
  for (const key of ["summary", "practice", "outcomes", "experience"] as const) {
    children.push(paragraph(CASE_SECTIONS[key], 28, true));
    if (key === "practice") {
      const rows = Array.isArray(content.framework?.rows) ? content.framework.rows : [];
      try {
        if (rows.length < 4 || rows.length > 6 || rows.some((row) => !row.phase || !row.content || row.subPoints.length < 2 || !row.methods.length)) {
          throw new Error("模式图数据不完整");
        }
        const png = await generateFrameworkDiagram({ rows });
        const width = 530;
        const height = Math.round(width * png.readUInt32BE(20) / png.readUInt32BE(16));
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({ type: "png", data: png, transformation: { width, height } })],
        }));
      } catch {
        warnings.push("模式图生成失败，Word 已保留文字版模式说明。");
        const outline = rows.filter((row) => row?.phase && row?.content).map((row) => `${row.phase}：${row.content}`);
        if (outline.length) children.push(...outline.map((line) => paragraph(line)));
      }
    }
    for (const line of content[key].split(/\n+/).map((part) => part.trim()).filter(Boolean)) {
      const text = line.replace(/^#{1,6}\s*|\*\*/g, "");
      children.push(paragraph(text, 24, key === "practice" && /^(模式提炼|具体做法)[：:]?$/.test(text)));
    }
  }
  return Packer.toBuffer(new Document({
    title: content.title,
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1797, right: 1797, footer: 720 } } },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font, size: 18 })],
      })] }) },
      children,
    }],
  }));
}
