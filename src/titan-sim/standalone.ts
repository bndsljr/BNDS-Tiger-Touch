#!/usr/bin/env node
/**
 * 独立运行 Titan 模拟器 —— 用于：
 * - 在没有控台时开发与联调
 * - 手工 curl 探测 HTTP 行为
 * - 让 WebUI 有一个可连的"控台"
 *
 * 用法：
 *   node src/titan-sim/standalone.ts [--port 4500] [--verbose]
 */

import { TitanSim } from './server.ts';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4500;
const verbose = args.includes('--verbose') || args.includes('-v');

const sim = new TitanSim({ port, logRequests: verbose });
const { url } = await sim.listen();

console.log(`Titan 模拟器已启动：${url}`);
console.log('');
console.log('可试：');
console.log(`  curl '${url}/titan/get/2/System/SoftwareVersion'`);
console.log(`  curl '${url}/titan/get/2/Show/ShowName'`);
console.log(`  curl '${url}/titan/handles' | head -c 400`);
console.log(
  `  curl '${url}/titan/script/2/Playbacks/FirePlaybackAtLevel?handle_userNumber=1&level_level=1&alwaysRefire=true'`,
);
console.log('');
console.log('按 Ctrl-C 退出。');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void sim.close().then(() => process.exit(0));
  });
}
