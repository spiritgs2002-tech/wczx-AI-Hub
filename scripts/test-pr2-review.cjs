/* MUST KEEP COMPATIBILITY: 回归覆盖旧备份、新备份及恢复锁，不读取或修改真实数据库。
 * 📐 CONTRACT: 测试仅使用系统临时目录和合成数据；不依赖开发服务器。
 * 🔗 RELATED: src/lib/teacher-backup-crypto.ts、src/lib/teacher-restore-lock.ts。
 * ⛔ DO NOT REVERT: v2 参数加强不能导致历史备份无法解密或弱化未知锁文件处理。 */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
const { encryptTeacherBackup, decryptTeacherBackup } = require(path.join(root, 'src/lib/teacher-backup-crypto.ts'));
const { withTrackedDataAccess, withTrackedFileAccess, waitForTrackedDataAccess } = require(path.join(root, 'src/lib/teacher-restore-lock.ts'));
const input = Buffer.from('synthetic test data');
const password = 'test-password-123';
function legacyBackup() {
  const magic = Buffer.from('WCZXBACKUP\x01', 'binary');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(magic);
  const data = Buffer.concat([cipher.update(input), cipher.final()]);
  return Buffer.concat([magic, salt, iv, cipher.getAuthTag(), data]);
}
async function main() {
  assert.deepEqual(await decryptTeacherBackup(legacyBackup(), password), input, 'v1 向后兼容');
  const v2 = await encryptTeacherBackup(input, password);
  assert.equal(v2[10], 2, '新备份使用 v2');
  assert.deepEqual(await decryptTeacherBackup(v2, password), input, 'v2 往返');
  await assert.rejects(decryptTeacherBackup(v2, 'wrong-password'), /密码错误或备份文件已损坏/);
  const corrupted = Buffer.from(v2); corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(decryptTeacherBackup(corrupted, password), /密码错误或备份文件已损坏/);
  const future = Buffer.from(v2); future[10] = 3;
  await assert.rejects(decryptTeacherBackup(future, password), /格式不正确/);
  // MUST AWAIT EARLIER KDF TESTS: 本测试依赖前面的派生全部结束、共享队列为空。
  // 📐 CONTRACT: 同时提交 5 项，其中 4 项进入队列、1 项被拒绝。
  // 🔗 RELATED: src/lib/teacher-backup-crypto.ts 的进程级 KDF 队列。
  // ⛔ DO NOT REVERT: 并行化前序测试或共用繁忙进程会使本断言产生误报。
  const jobs = await Promise.allSettled(Array.from({ length: 5 }, () => encryptTeacherBackup(input, password)));
  assert.equal(jobs.filter((j) => j.status === 'fulfilled').length, 4, 'KDF 排队上限');
  assert.equal(jobs.filter((j) => j.status === 'rejected').length, 1, '超出排队上限拒绝');
  console.log('备份 v1/v2 兼容、错误密码、篡改、未知版本及 KDF 排队：通过');

  const before = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wczx-review-tests-'));
  try {
    process.chdir(temp); fs.mkdirSync('.teacher-active');
    for (const f of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) fs.writeFileSync(path.join('.teacher-active', f), '');
    await waitForTrackedDataAccess();
    fs.writeFileSync('.teacher-active/unexpected', '');
    await assert.rejects(waitForTrackedDataAccess(), /未知文件/);
    fs.unlinkSync('.teacher-active/unexpected');
    fs.writeFileSync('.teacher-active/.unknown', '');
    await assert.rejects(waitForTrackedDataAccess(), /未知文件/);
    fs.unlinkSync('.teacher-active/.unknown');
    fs.writeFileSync('.teacher-active/99999999-abcdef2026abcdef2026.active', '');
    await waitForTrackedDataAccess();
    assert.equal(fs.existsSync('.teacher-active/99999999-abcdef2026abcdef2026.active'), false, '僵尸标记清理');
    let release;
    const running = withTrackedDataAccess(() => new Promise((resolve) => { release = resolve; }));
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === '@/lib/prisma') return { prisma: {} };
      return originalLoad.apply(this, arguments);
    };
    let readImageFile;
    try { ({ readImageFile } = require(path.join(root, 'src/lib/image-library.ts'))); }
    finally { Module._load = originalLoad; }
    fs.mkdirSync('uploads/image-library/group', { recursive: true });
    fs.writeFileSync('uploads/image-library/group/image.png', 'example');
    assert.equal(readImageFile('group', 'image.png').toString(), 'example');
    fs.mkdirSync('.teacher-restore');
    assert.throws(() => withTrackedFileAccess(() => {}), /正在恢复数据/);
    assert.throws(() => readImageFile('group', 'image.png'), /正在恢复数据/);
    let drained = false;
    const waiting = waitForTrackedDataAccess().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(drained, false, '必须等待活跃请求');
    release(); await running; await waiting;
    console.log('系统元数据、未知文件、僵尸标记、图片读取锁及活跃访问等待：通过');
  } finally { process.chdir(before); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
