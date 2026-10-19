// 检查 dist/client.js 里实际被内联的模块与保留的外部 require。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');

const hasProtocol = src.includes('@dsh-gamecenter/protocol');
const requires = [...src.matchAll(/__require\((["'])([^"']+)\1\)/g)].map((m) => m[2]);
const uniq = [...new Set(requires)];

console.log('bundle 字节数        =', Buffer.byteLength(src, 'utf8'));
console.log('是否含 protocol 字样 =', hasProtocol);
console.log('外部 require 列表    =', uniq.length === 0 ? '(无)' : uniq.join(', '));

// 检查是否有 protocol 的实现被内联（例如 BRIDGE_METHODS 的字面量数组）
const inlinedBridgeMethods = /\[\s*["']handshake["']\s*,\s*["']ai\.generate["']/.test(src);
console.log('是否内联 protocol 常量 =', inlinedBridgeMethods);
