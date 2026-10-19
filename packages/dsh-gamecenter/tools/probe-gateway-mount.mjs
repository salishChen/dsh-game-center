/**
 * 只读探针：从 app.asar 取出 dsh-api-gateway Client 的 $mount 实现片段。
 * 用法：node tools/probe-gateway-mount.mjs [asarPath]
 * 不修改安装目录，仅 fs.openSync(path, 'r')。
 */
import fs from 'node:fs';

const asarPath = process.argv[2]
  ?? 'D:/Program Files/deepseek harness/resources/app.asar';

function readNode(fd, header, base, innerPath) {
  let node = header;
  for (const part of innerPath.split('/')) {
    node = node?.files?.[part];
    if (!node) throw new Error(`not in asar: ${innerPath}`);
  }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  return buf.toString('utf8');
}

const fd = fs.openSync(asarPath, 'r');
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const base = 16 + jsonLen;

  const src = readNode(fd, header, base, 'dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/index.js');
  const needle = '$mount';
  let at = -1;
  let hits = 0;
  while ((at = src.indexOf(needle, at + 1)) !== -1) hits += 1;
  const first = src.indexOf(needle);
  process.stdout.write(`hits=${hits}\n`);
  if (first >= 0) process.stdout.write(src.slice(Math.max(0, first - 1200), first + 4000) + '\n');
} finally {
  fs.closeSync(fd);
}
