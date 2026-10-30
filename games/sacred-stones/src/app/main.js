/**
 * 网页外壳：把内核、画面、按键、存档池接成一个能玩的页面
 *
 * 分工（刻意不合并）：
 *   boot.js      内核怎么起来
 *   renderer.js  一帧画面怎么上屏
 *   keyboard.js  键盘怎么变成 GBA 按键
 *   本文件        把这些接起来 + 存档 UI + 生命周期
 *
 * 三条硬约束（都踩过坑）：
 *   1. 定步长 60Hz，不读 rAF 的时间差来推进模拟。模拟步长一变，逐帧回放就对不上。
 *   2. ROM 只在内存里，不上传、不落盘、不进 git。用户每次自己选文件。
 *   3. 关闭页面时先存档（进自动池 reason 'close'）。浏览器不保证异步写一定完成，
 *      所以这里在 visibilitychange 变隐藏时就存一次，而不是只赌 unload。
 */

import {bootKernel} from './boot.js';
import {createRenderer} from './renderer.js';
import {createKeyboardInput} from './keyboard.js';
import {createRomCache} from './rom-cache.js';
import {createKernelAdapter} from '../core/kernel-adapter.js';
import {createSavestateBridge} from '../save/savestate-bridge.js';
import {createGameSession} from '../save/game-session.js';
import {createIdbStore} from '../save/idb-store.js';

/** 60Hz 定步长（毫秒）。不写成 16.6667 的近似：用分数累加避免漂移。 */
const STEP_MS = 1000 / 60;
/** 一帧最多补跑几步。标签页切回来时不要试图追回几百帧。 */
const MAX_STEPS_PER_FRAME = 4;

const GAME_VERSION = '0.0.1';

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少元素 #${id}`);
  return node;
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const state = {
  kernel: null,
  adapter: null,
  session: null,
  renderer: null,
  input: null,
  running: false,
  rafId: 0,
  accumulator: 0,
  lastTime: 0,
  closing: false,
};

const ui = {
  picker: el('picker'),
  romInput: el('rom-input'),
  useCached: el('use-cached'),
  forgetCached: el('forget-cached'),
  cacheHint: el('cache-hint'),
  stage: el('stage'),
  canvas: el('screen'),
  status: el('status'),
  saveBtn: el('save-btn'),
  savesBtn: el('saves-btn'),
  exitBtn: el('exit-btn'),
  panel: el('saves-panel'),
  list: el('saves-list'),
  usage: el('auto-usage'),
  closePanel: el('close-panel'),
  fps: el('fps'),
};

function setStatus(text, tone = 'info') {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
}

async function readRom(file) {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/** 记住这次用的卡带（本机 IndexedDB），下次开页面不用重选 16 MB 文件。 */
function rememberRom(bytes) {
  try {
    const cache = createRomCache({indexedDB: globalThis.indexedDB});
    void cache.save(bytes).catch(() => {
      /* 缓存失败不影响玩，静默即可 */
    });
  } catch {
    /* 没有 IndexedDB（隐私模式等）就每次重选 */
  }
}

async function refreshCachedRom() {
  let cached = null;
  try {
    cached = await createRomCache({indexedDB: globalThis.indexedDB}).load();
  } catch {
    cached = null;
  }
  if (!cached) {
    ui.useCached.hidden = true;
    ui.forgetCached.hidden = true;
    ui.cacheHint.textContent = '';
    return;
  }
  ui.useCached.hidden = false;
  ui.forgetCached.hidden = false;
  ui.useCached.textContent = `使用上次的卡带（${formatBytes(cached.bytes.length)}）`;
  ui.cacheHint.textContent = cached.savedAt
    ? `上次使用：${formatTime(cached.savedAt)} · 只存在本机`
    : '只存在本机';
}

async function startGame(name, rom) {
  setStatus(`启动 ${name} …`);
  let gba;
  try {
    gba = bootKernel(rom);
  } catch (error) {
    setStatus(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    return;
  }

  state.kernel = gba;
  state.adapter = createKernelAdapter(gba);
  state.renderer = createRenderer(ui.canvas);
  state.renderer.clear();

  const store = createIdbStore({indexedDB: globalThis.indexedDB, name: 'sacred-stones'});
  const bridge = createSavestateBridge({kernel: state.adapter, gameVersion: () => GAME_VERSION});
  state.session = createGameSession({
    bridge,
    store,
    gameVersion: () => GAME_VERSION,
    onError: (error) => setStatus(`自动存档失败：${error?.message ?? error}`, 'error'),
  });

  state.input = createKeyboardInput({kernel: state.adapter, target: globalThis});
  state.input.releaseAll();

  ui.picker.hidden = true;
  ui.stage.hidden = false;
  state.running = true;
  state.lastTime = performance.now();
  state.accumulator = 0;

  state.session.start();
  loop();
  setStatus(`已启动：${name}（${formatBytes(rom.length)}）· 存档自动进 IndexedDB`, 'ok');
  void refreshSaves();
  rememberRom(rom);
}

let framesThisSecond = 0;
let fpsTimer = 0;

function step(deltaMs) {
  if (!state.running) return;
  state.accumulator += deltaMs;
  let steps = 0;
  while (state.accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
    state.adapter.runFrame();
    state.accumulator -= STEP_MS;
    steps += 1;
    framesThisSecond += 1;
  }
  // 补不上就丢掉，宁可慢放也不要突然瞬移
  if (state.accumulator > STEP_MS * MAX_STEPS_PER_FRAME) state.accumulator = 0;
  if (steps > 0) state.renderer.draw(state.adapter.framebuffer());
}

function loop() {
  if (!state.running) return;
  const now = performance.now();
  const delta = now - state.lastTime;
  state.lastTime = now;
  step(delta);

  fpsTimer += delta;
  if (fpsTimer >= 1000) {
    ui.fps.textContent = `${Math.round((framesThisSecond * 1000) / fpsTimer)} fps`;
    framesThisSecond = 0;
    fpsTimer = 0;
  }
  state.rafId = requestAnimationFrame(loop);
}

function pause() {
  if (!state.running) return;
  state.running = false;
  cancelAnimationFrame(state.rafId);
  state.input?.releaseAll();
}

function resume() {
  if (state.running || !state.session) return;
  state.running = true;
  state.lastTime = performance.now();
  state.accumulator = 0;
  loop();
}

async function doSave() {
  if (!state.session) return;
  const name = `手动 ${new Date().toLocaleTimeString('zh-CN')}`;
  try {
    const {meta} = await state.session.saveManual(name);
    setStatus(`已存档：${meta.slot}（${formatBytes(meta.bytes)}）`, 'ok');
    await refreshSaves();
  } catch (error) {
    setStatus(`存档失败：${error?.message ?? error}`, 'error');
  }
}

async function refreshSaves() {
  if (!state.session) return;
  const all = await state.session.listAll();
  const usage = await state.session.autoUsage();
  ui.usage.textContent = `自动档 ${usage.used}/${usage.limit}`;

  if (all.length === 0) {
    ui.list.innerHTML = '<li class="empty">还没有存档</li>';
    return;
  }

  ui.list.innerHTML = '';
  for (const meta of all.slice().reverse()) {
    const li = document.createElement('li');
    li.className = `save-row pool-${meta.pool}`;

    const label = document.createElement('div');
    label.className = 'save-label';
    const title = document.createElement('strong');
    title.textContent = meta.pool === 'manual' ? meta.name || '手动存档' : meta.reason === 'close' ? '关闭时自动存档' : '定时自动存档';
    const sub = document.createElement('span');
    sub.textContent = `${formatTime(meta.createdAt)} · ${formatBytes(meta.bytes)}`;
    label.append(title, sub);

    const loadBtn = document.createElement('button');
    loadBtn.textContent = '读取';
    loadBtn.onclick = () => void loadSave(meta.slot);

    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.className = 'ghost';
    delBtn.onclick = async () => {
      await state.session.remove(meta.slot);
      await refreshSaves();
    };

    li.append(label, loadBtn, delBtn);
    ui.list.append(li);
  }
}

async function loadSave(slot) {
  const wasRunning = state.running;
  pause();
  const result = await state.session.load(slot);
  if (!result.ok) {
    setStatus(`读档失败：${result.message}`, 'error');
    if (wasRunning) resume();
    return;
  }
  state.session.start();
  state.renderer.draw(state.adapter.framebuffer());
  ui.panel.hidden = true;
  resume();
  setStatus(`已读取：${slot}`, 'ok');
}

async function shutdown(reason) {
  if (state.closing || !state.session) return;
  state.closing = true;
  pause();
  try {
    await state.session.close();
    setStatus(reason, 'ok');
  } catch (error) {
    setStatus(`关闭存档失败：${error?.message ?? error}`, 'error');
  }
  state.closing = false;
}

ui.romInput.addEventListener('change', () => {
  const file = ui.romInput.files?.[0];
  if (!file) return;
  void (async () => {
    setStatus(`读取 ${file.name} …`);
    try {
      const rom = await readRom(file);
      await startGame(file.name, rom);
    } catch (error) {
      setStatus(`读不到文件：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  })();
});

ui.useCached.addEventListener('click', () => {
  void (async () => {
    setStatus('读取上次的卡带 …');
    try {
      const cached = await createRomCache({indexedDB: globalThis.indexedDB}).load();
      if (!cached) {
        setStatus('本机没有缓存的卡带，请重新选择文件', 'error');
        await refreshCachedRom();
        return;
      }
      await startGame('上次使用的卡带', cached.bytes);
    } catch (error) {
      setStatus(`读不到缓存：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  })();
});

ui.forgetCached.addEventListener('click', () => {
  void (async () => {
    try {
      await createRomCache({indexedDB: globalThis.indexedDB}).clear();
      setStatus('已忘掉本机缓存的卡带（文件本身没动）', 'ok');
    } catch (error) {
      setStatus(`清除失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    await refreshCachedRom();
  })();
});

ui.saveBtn.addEventListener('click', () => void doSave());

ui.savesBtn.addEventListener('click', async () => {
  ui.panel.hidden = !ui.panel.hidden;
  if (!ui.panel.hidden) {
    pause();
    await refreshSaves();
  } else {
    resume();
  }
});

ui.closePanel.addEventListener('click', () => {
  ui.panel.hidden = true;
  resume();
});

ui.exitBtn.addEventListener('click', async () => {
  await shutdown('已存档并退出（可以关掉这个页面了）');
});

// 页面被切走/关闭：先存再走。visibilitychange 比 unload 可靠得多。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void shutdown('页面隐藏，已自动存档');
  }
});
globalThis.addEventListener('pagehide', () => {
  void shutdown('页面关闭，已自动存档');
});

setStatus('请选择卡带文件（ROM 只在本地内存里，不上传）');
void refreshCachedRom();
