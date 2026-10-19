/**
 * 只读探针：打印 dsh-api-remotes client 中 mount 循环附近源码。
 */
import fs from 'node:fs';

const asarPath = process.argv[2]
  ?? 'D:/Program Files/deepseek harness/resources/app.asar';

const fd = fs.openSync(asarPath, 'r');
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const base = 16 + jsonLen;
  let cur = header.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-api-remotes'];
  for (const part of ['lib', 'client.js']) cur = cur.files[part];
  const buf = Buffer.alloc(cur.size);
  fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset));
  const lines = buf.toString('utf8').split('\n');
  const from = Number(process.argv[3] ?? 23620);
  const to = Number(process.argv[4] ?? 23720);
  for (let i = from; i < Math.min(to, lines.length); i += 1) {
    process.stdout.write(`${i}: ${lines[i].slice(0, 400)}\n`);
  }
  process.stdout.write(`total lines=${lines.length}\n`);
} finally {
  fs.closeSync(fd);
}
