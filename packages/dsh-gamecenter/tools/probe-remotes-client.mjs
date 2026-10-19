/**
 * 只读探针：定位 dsh-api-remotes Client 入口如何取得并 mount 各 `/remote` 贡献。
 * 用法：node tools/probe-remotes-client.mjs [asarPath]
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
  const node = header.files.dsh.files.node_modules.files['@deepseek-ai'];
  const read = (innerPath) => {
    let cur = node;
    for (const part of innerPath.split('/')) {
      cur = cur?.files?.[part];
      if (!cur) throw new Error(`not in asar: ${innerPath}`);
    }
    const buf = Buffer.alloc(cur.size);
    fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset));
    return buf.toString('utf8');
  };

  const src = read('dsh-api-remotes/lib/client.js');
  process.stdout.write(`client.js len=${src.length}\n`);
  const lines = src.split('\n');
  const wanted = ['$mount(', 'remote', 'TYPERT_REMOTE', 'typert.remotes'];
  for (const needle of wanted) {
    process.stdout.write(`\n##### needle ${needle}\n`);
    let count = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(needle)) continue;
      count += 1;
      if (count > 6) break;
      process.stdout.write(`${i}: ${lines[i].slice(0, 300)}\n`);
    }
    process.stdout.write(`hits=${count}\n`);
  }
} finally {
  fs.closeSync(fd);
}
