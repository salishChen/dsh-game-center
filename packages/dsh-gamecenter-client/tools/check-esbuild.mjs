// 探测本地 esbuild 是否可用（不用 npx 的临时安装目录，避免 Node 解析不到包）。
try {
  const mod = await import('esbuild');
  console.log('local esbuild ok:', typeof mod.build);
} catch (error) {
  console.log('no local esbuild:', error.code);
}
