#!/usr/bin/env node
/**
 * 应用入口。
 *
 * 用法：
 *   node src/main.ts                       # 启动 WebUI（默认 8091）
 *   node src/main.ts --sim                 # 同时拉起内置 Titan 模拟器并自动连接
 *   node src/main.ts --console <ip>        # 连接真实控台（现场）
 *   node src/main.ts --port 9000
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AppServer } from './server/app.ts';
import { TitanSim } from './titan-sim/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const port = Number(flag('--port') ?? 8091);
const webRoot = join(projectRoot, 'src', 'web');
const dataRoot = join(projectRoot, 'data');

let sim: TitanSim | null = null;
let autoConnect: string | undefined;

if (argv.includes('--sim')) {
  sim = new TitanSim({ port: Number(flag('--sim-port') ?? 4500), logRequests: argv.includes('-v') });
  const s = await sim.listen();
  autoConnect = s.url;
  console.log(`内置 Titan 模拟器：${s.url}`);
}

const consoleIp = flag('--console');
if (consoleIp) {
  autoConnect = consoleIp.startsWith('http') ? consoleIp : `http://${consoleIp}:4430`;
}

const app = new AppServer({ port, webRoot, dataRoot, autoConnect });
const { url } = await app.listen();

console.log('');
console.log('  BNDS 剧场灯光控制系统');
console.log('  ────────────────────────────────────────');
console.log(`  WebUI      ${url}`);
if (autoConnect) console.log(`  控台地址   ${autoConnect}`);
else console.log('  控台地址   （未连接 —— 可在 WebUI「连接」页填写，或加 --sim 启动模拟器）');
console.log('');
console.log('  按 Ctrl-C 退出。');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void (async () => {
      await app.close();
      if (sim) await sim.close();
      process.exit(0);
    })();
  });
}
