// 数据备份与恢复（导出 / 导入）
//
// 目标：一个文件就能把「配置 + 聊天存档 + 记忆 + 表情包 + 技能配置」整体搬走，
// 换机器/重装/回滚时不用手动拷 data 目录。
//
// 文件格式：gzip(JSON)
//   { format, version, exportedAt, appVersion, fileCount, rawBytes, files: { 相对路径: base64 } }
//
// 为什么不是 .zip：项目依赖里没有 archiver，Node 内置只有 zlib；
// gzip + 单个 JSON 已经够用（文本压缩比很高），浏览器端下载/上传也简单，
// 不用引入新依赖。
//
// 安全约束：
//   · 导入时逐条校验相对路径，拒绝绝对路径、`..`、反斜杠，防止备份包写到数据目录外；
//   · 导入前先把当前 data 复制成同级 `data.backup-<时间戳>`，失败即中止；
//   · 清空时保留 qq-agent.lock —— 那是本进程活着的凭证，删了会让单实例判定失效。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const BACKUP_FORMAT = 'qq-agent-backup';
export const BACKUP_VERSION = 1;

// 不打包的目录：可重建的浏览器缓存 / 日志 / 视频缓存
const EXCLUDE_DIRS = new Set(['electron-user-data', 'logs', 'video-cache']);
// 不打包的顶层文件：运行态锁与可重建缓存
const EXCLUDE_FILES = new Set(['qq-agent.lock', 'session-index-cache.json', 'price-feed-cache.json']);
// 不打包的嵌套目录（表情包临时下载）
const EXCLUDE_NESTED = new Set(['whale-memes/tmp']);

/** 递归收集要打包的文件（相对路径统一用 /）。 */
function collectFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!rel && EXCLUDE_DIRS.has(name)) continue;
        if (EXCLUDE_NESTED.has(r)) continue;
        walk(full, r);
      } else if (st.isFile()) {
        if (!rel && EXCLUDE_FILES.has(name)) continue;
        if (name.endsWith('.tmp') || name.endsWith('.log')) continue;
        out.push({ rel: r, full });
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * 生成备份包。
 * @param {string} dataDir 用户数据目录
 * @param {string} [appVersion] 版本号，仅做记录
 * @returns {{ buffer: Buffer, fileCount: number, rawBytes: number, compressedBytes: number }}
 */
export function buildBackup(dataDir, appVersion = '') {
  const root = path.resolve(dataDir);
  if (!fs.existsSync(root)) throw new Error('数据目录不存在');

  const files = {};
  let rawBytes = 0;
  let fileCount = 0;
  for (const f of collectFiles(root)) {
    let buf;
    try { buf = fs.readFileSync(f.full); } catch { continue; }
    files[f.rel] = buf.toString('base64');
    rawBytes += buf.length;
    fileCount += 1;
  }
  if (!fileCount) throw new Error('数据目录是空的，没有可导出的内容');

  const pkg = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    fileCount,
    rawBytes,
    files
  };
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify(pkg), 'utf8'), { level: 9 });
  return { buffer, fileCount, rawBytes, compressedBytes: buffer.length };
}

/**
 * 用备份包覆盖当前数据目录。
 * @param {Buffer} buffer gzip 或纯 JSON 的备份内容
 * @param {string} dataDir 用户数据目录
 * @returns {{ restored: number, backupDir: string, exportedAt: string, appVersion: string }}
 */
export function restoreBackup(buffer, dataDir) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('上传的备份文件是空的');
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  let raw;
  try {
    raw = isGzip ? zlib.gunzipSync(buffer) : buffer;
  } catch {
    throw new Error('备份文件不是有效的 gzip');
  }
  let pkg;
  try {
    pkg = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('备份文件内容不是合法 JSON');
  }
  if (pkg?.format !== BACKUP_FORMAT) throw new Error('不是 QQ Agent 的备份文件（format 不匹配）');
  if (Number(pkg.version) > BACKUP_VERSION) throw new Error('备份来自更新版本的 QQ Agent，请先升级程序');
  if (!pkg.files || typeof pkg.files !== 'object' || Array.isArray(pkg.files)) throw new Error('备份文件缺少 files 字段');

  const entries = Object.entries(pkg.files);
  if (!entries.length) throw new Error('备份里没有任何文件');
  if (entries.length > 200000) throw new Error('备份条目异常多，疑似损坏');

  const root = path.resolve(dataDir);
  const targets = [];
  for (const [rel, b64] of entries) {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('备份里存在空路径');
    if (rel.includes('\\') || path.isAbsolute(rel) || rel.split('/').includes('..')) {
      throw new Error(`备份里有非法路径：${rel}`);
    }
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`备份路径越界：${rel}`);
    targets.push({ dest, b64: String(b64 ?? '') });
  }

  // 1) 先把当前数据整份复制一份，失败则中止（宁可导不进去，也不能把现有数据弄丢）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `${root}.backup-${stamp}`;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(root, backupDir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`备份当前数据失败，已中止导入：${error?.message ?? error}`);
  }

  // 2) 清空（保留运行态锁）
  for (const name of fs.readdirSync(root)) {
    if (name === 'qq-agent.lock') continue;
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* 单个失败继续 */ }
  }

  // 3) 写回备份内容
  let restored = 0;
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.dest), { recursive: true });
    fs.writeFileSync(t.dest, Buffer.from(t.b64, 'base64'));
    restored += 1;
  }

  return {
    restored,
    backupDir,
    exportedAt: String(pkg.exportedAt || ''),
    appVersion: String(pkg.appVersion || '')
  };
}
