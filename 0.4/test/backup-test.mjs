// 备份 / 恢复（导出与导入）测试
// 覆盖：打包过滤、二进制保真、导入前自动备份、非法路径拒绝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { buildBackup, restoreBackup, BACKUP_FORMAT } from '../src/backup.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-test-'));
const data = path.join(root, 'data');
fs.mkdirSync(path.join(data, 'messages'), { recursive: true });
fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
fs.mkdirSync(path.join(data, 'stickers'), { recursive: true });

fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ a: 1 }));
fs.writeFileSync(path.join(data, 'messages', 'group_1.json'), JSON.stringify([{ text: '你好' }]));
fs.writeFileSync(path.join(data, 'qq-agent.lock'), '26916');
fs.writeFileSync(path.join(data, 'logs', 'x.log'), 'log');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
fs.writeFileSync(path.join(data, 'stickers', 'a.png'), png);

const pkg = buildBackup(data, '0.4.0');
assert.equal(pkg.fileCount, 3, '应只打包 config、消息、图片（排除 lock 与 logs）');
assert.ok(pkg.compressedBytes > 0);

// 改动数据（模拟"重装前/换机后"）
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ a: 2 }));
fs.unlinkSync(path.join(data, 'messages', 'group_1.json'));

const restored = restoreBackup(pkg.buffer, data);
assert.equal(restored.restored, 3, '应恢复 3 个文件');
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).a, 1, '配置应恢复为备份里的值');
assert.ok(fs.existsSync(path.join(data, 'messages', 'group_1.json')), '消息存档应恢复');
assert.equal(Buffer.compare(fs.readFileSync(path.join(data, 'stickers', 'a.png')), png), 0, '二进制应逐字节一致');
assert.ok(fs.existsSync(path.join(restored.backupDir, 'config.json')), '导入前应自动备份当前数据');

// 非法路径必须拒绝：否则备份包能把文件写到数据目录外
const evil = zlib.gzipSync(Buffer.from(JSON.stringify({
  format: BACKUP_FORMAT,
  version: 1,
  files: { '../evil.txt': Buffer.from('x').toString('base64') }
}), 'utf8'));
let rejected = false;
try {
  restoreBackup(evil, data);
} catch {
  rejected = true;
}
assert.equal(rejected, true, '包含 .. 的路径必须被拒绝');

// 非备份文件必须拒绝
let badFormat = false;
try {
  restoreBackup(zlib.gzipSync(Buffer.from('{"hello":1}')), data);
} catch {
  badFormat = true;
}
assert.equal(badFormat, true, 'format 不匹配必须被拒绝');

// 纯 JSON（未 gzip）也应能导入
const plain = JSON.parse(zlib.gunzipSync(pkg.buffer).toString('utf8'));
const plainRestore = restoreBackup(Buffer.from(JSON.stringify(plain)), data);
assert.equal(plainRestore.restored, 3);

fs.rmSync(root, { recursive: true, force: true });
console.log('✅ backup-test 全部通过（打包过滤 / 二进制保真 / 自动备份 / 非法路径拒绝 / 纯 JSON 兼容）');
