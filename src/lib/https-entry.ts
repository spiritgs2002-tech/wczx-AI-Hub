/**
 * 局域网 HTTPS 入口：在 HTTPS_PORT（默认 3443）上开一个 HTTPS 服务，把请求原样转发给本机的 Next 服务（http://127.0.0.1:PORT）。
 *
 * 为什么：浏览器只在「安全来源」（HTTPS 或 localhost）开放麦克风。学生平板用 http://教师IP:3000 访问时，
 *   录音功能被浏览器直接禁用，与权限设置无关（2026-11-12 安卓平板实测）。chrome://flags 方案要在每台平板上
 *   手输地址，老师反馈不方便；改为班级二维码直接指向本入口，学生扫码后只需在证书提示页点一次「继续访问」。
 * 现状 / 约束：
 *   - 由 src/instrumentation.ts 在服务启动时调用，dev 与 next start 都生效，启动脚本无需改动；
 *   - 证书为自签名，首次启动生成到项目根目录 .https/（已 gitignore），本机局域网 IP 变化时自动重新生成；
 *   - 端口被占用或证书生成失败时只打印日志、不影响 http://localhost:3000 的正常使用；
 *   - 设置环境变量 HTTPS_PORT=0 可关闭本入口。
 * 📐 CONTRACT：globalThis.__wczxHttpsEntry = { port } 表示入口已在监听；
 *   src/app/api/system/lan-address/route.ts 读取它返回 httpsPort，班级二维码据此生成 https 地址。
 * ⚠️ GOTCHA：必须转发 X-Forwarded-Proto/Host，否则 Next 生成的重定向会变成 http://IP:3443（协议错位，打不开）。
 * ⛔ DO NOT 改成 HTTP→HTTPS 强制跳转：教师本机 http://localhost:3000 本来就是安全来源，强跳只会多出证书警告。
 * 🔗 RELATED：src/instrumentation.ts、next.config.mjs（instrumentationHook / serverComponentsExternalPackages）、
 *   src/app/teacher/classes/page.tsx（getStudentEntryUrl）、readme.md 录音常见问题。
 */
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";

type EntryState = { port: number };
const g = globalThis as unknown as { __wczxHttpsEntry?: EntryState; __wczxHttpsStarting?: boolean };

export function getHttpsEntry(): EntryState | null {
  return g.__wczxHttpsEntry || null;
}

function lanIps(): string[] {
  const ips: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (isV4 && !info.internal && !info.address.startsWith("169.254.")) ips.push(info.address);
    }
  }
  return ips.sort();
}

async function loadOrCreateCert(dir: string): Promise<{ key: string; cert: string }> {
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const metaFile = path.join(dir, "ips.json");
  const ips = lanIps();
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    if (JSON.stringify(meta.ips) === JSON.stringify(ips)) {
      return { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
    }
  } catch {
    // 没有证书或元数据损坏 → 重新生成
  }
  const selfsigned = (await import("selfsigned")).default;
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: "commonName", value: ips[0] || "localhost" }], {
    keySize: 2048,
    days: 3650,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ ips }));
  return { key: pems.private, cert: pems.cert };
}

export async function startHttpsEntry(): Promise<void> {
  if (g.__wczxHttpsEntry || g.__wczxHttpsStarting) return;
  const port = Number(process.env.HTTPS_PORT ?? 3443);
  if (!port) return;
  const target = Number(process.env.PORT || 3000);
  g.__wczxHttpsStarting = true;
  try {
    const { key, cert } = await loadOrCreateCert(path.join(process.cwd(), ".https"));
    const agent = new http.Agent({ keepAlive: true });

    const server = https.createServer({ key, cert }, (req, res) => {
      const host = req.headers.host || `localhost:${port}`;
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: target,
          method: req.method,
          path: req.url,
          agent,
          headers: {
            ...req.headers,
            "x-forwarded-proto": "https",
            "x-forwarded-host": host,
            "x-forwarded-port": String(port),
            "x-forwarded-for": req.socket.remoteAddress || "",
          },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("服务正在启动，请稍后刷新");
      });
      req.pipe(upstream);
    });

    // WebSocket（开发模式热更新等）：直接双向转发原始连接
    server.on("upgrade", (req, socket, head) => {
      const up = net.connect(target, "127.0.0.1", () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => resolve());
    });
    server.on("error", (e) => console.error("[HTTPS 入口] 运行出错：", e));
    g.__wczxHttpsEntry = { port };
    const ips = lanIps();
    console.log(
      `[HTTPS 入口] 已启动，学生扫码录音用：${ips.length ? ips.map((ip) => `https://${ip}:${port}`).join("  ") : `https://localhost:${port}`}`,
    );
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.warn(
      code === "EADDRINUSE"
        ? `[HTTPS 入口] 端口 ${port} 已被占用，跳过（学生录音需 HTTPS，可设置 HTTPS_PORT 换端口）`
        : `[HTTPS 入口] 启动失败，已跳过：${(e as Error)?.message || e}`,
    );
  } finally {
    g.__wczxHttpsStarting = false;
  }
}
