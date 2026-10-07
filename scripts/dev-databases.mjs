#!/usr/bin/env node
/**
 * 起本地数据库并打印可直接 export 的真库测试变量。
 *
 * ```bash
 * node scripts/dev-databases.mjs up        # 起全部（或指定 pg mysql …）
 * eval "$(node scripts/dev-databases.mjs env)"   # 导出 ACTOR_TEST_*_URL
 * npm test                                 # 真库用例这时才会真的跑（否则显式 skip）
 * node scripts/dev-databases.mjs down      # 收工（-v 清数据卷）
 * ```
 *
 * 设计原则：**没有 docker 就明确报错**（退出码 2），不静默跳过；`env` 子命令是纯打印，
 * 不依赖 docker，所以离线也能验证它（见 test/unit-dev-databases.test.js）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMPOSE_FILE = path.join(HERE, 'databases.compose.yml');

/** 起哪些服务（顺序即 up 的展开顺序）。 */
export const SERVICES = ['pg', 'mysql', 'mssql', 'redis', 'mongo'];

/**
 * 打印给使用者 export 的变量。端口必须与 `databases.compose.yml` 一致
 * （测试会交叉核对，避免"文档说一个端口、compose 开另一个"）。
 */
export const TEST_URLS = Object.freeze({
  ACTOR_TEST_PG_URL: 'postgres://actor:actor@127.0.0.1:55432/actor',
  ACTOR_TEST_MYSQL_URL: 'mysql://actor:actor@127.0.0.1:53306/actor',
  ACTOR_TEST_MSSQL_URL: 'mssql://sa:Act0rPassw0rd1@127.0.0.1:51433/actor',
  ACTOR_TEST_REDIS_URL: 'redis://127.0.0.1:56379/0',
  ACTOR_TEST_IOREDIS_URL: 'redis://127.0.0.1:56379/1',
  ACTOR_TEST_MONGO_URL: 'mongodb://actor:actor@127.0.0.1:57017/actor?authSource=admin',
});

/** 可直接喂给 shell 的 `export` 行。 */
export function envLines(urls = TEST_URLS) {
  return Object.entries(urls).map(([name, url]) => `export ${name}='${url}'`);
}

export const USAGE = [
  '用法：node scripts/dev-databases.mjs <up|down|status|env> [服务…]',
  '',
  '  up [服务…]   起库（默认全部；可只起 pg mysql …）',
  '  down         停库并删数据卷',
  '  status       看容器状态',
  '  env          打印 export ACTOR_TEST_*_URL 行（不依赖 docker）',
  '',
  `服务：${SERVICES.join(' ')}`,
].join('\n');

function dockerAvailable() {
  const probe = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function compose(args) {
  if (!dockerAvailable()) {
    process.stderr.write(
      '找不到 docker：真库测试需要本机有 docker（或自己准备数据库，然后 export ACTOR_TEST_*_URL）。\n' +
        `也可以只打印变量：node scripts/dev-databases.mjs env\n`,
    );
    return 2;
  }
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

function main(argv) {
  const [command = 'usage', ...rest] = argv;
  switch (command) {
    case 'up': {
      const services = rest.length > 0 ? rest : SERVICES;
      for (const service of services) {
        if (!SERVICES.includes(service)) {
          process.stderr.write(`不认识的服务 "${service}"。\n${USAGE}\n`);
          return 2;
        }
      }
      const status = compose(['up', '-d', ...services]);
      if (status !== 0) return status;
      process.stdout.write('\n库起来了。接下来：\n  eval "$(node scripts/dev-databases.mjs env)"\n  npm test\n');
      return 0;
    }
    case 'down':
      return compose(['down', '-v']);
    case 'status':
      return compose(['ps']);
    case 'env':
      process.stdout.write(`${envLines().join('\n')}\n`);
      return 0;
    default:
      process.stdout.write(`${USAGE}\n`);
      return command === 'usage' || command === '--help' || command === '-h' ? 0 : 2;
  }
}

// 只有被当作脚本直接执行时才跑 CLI（被 import 时不执行，便于测试）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
