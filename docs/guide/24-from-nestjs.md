# 24. 从 NestJS 过来：映射表、装饰器的替代、以及为什么没有装饰器

**你会得到**：NestJS 的每个核心概念在这里的对应物；**装饰器为什么不支持**（有可复现的证据）；
以及用声明式 API 达到同样效果的具体写法。

**前置**：用过 NestJS（controller/service/module/DI 那套）；跑得起来一个项目。　**耗时**：15 分钟。

## 1. 概念映射表

| NestJS | 本文档 | 差异要点 |
|---|---|---|
| `@Controller('notes')` + `@Get(':id')` | `defineController({…})` + `defineRoutes([get('/notes/:id', c)])` | 路由集中**声明在模块上**（不扫类元数据），启动期校验 |
| `@Injectable()` service + 构造函数注入 | `providers: { notes: (deps) => createNotesRepo(...) }`，控制器里 `ctx.get('notes')` | 依赖**显式声明**；缺依赖启动期报错，不会运行期 undefined |
| `@Module({ controllers, providers, imports })` | `defineModule({ name, providers, actors, routes })` | 同构；本文档多一层：Actor（有状态、串行） |
| DTO + `class-validator` | 控制器 `input: { title: { type: 'string', min: 1 } }` | 校验规则是**数据**（可序列化、可跨层复用），不是装饰器元数据 |
| `@UseGuards(JwtGuard)` | `atAuth(...)` 中间件 + 控制器 `auth` 声明 | 见 [13 鉴权](./13-auth.md)：作用域是路由/控制器/前缀 |
| `@UseInterceptors(LoggingInterceptor)` | `atPre/atPost(...)`（阶段即函数名） | 前后置都在一个函数里（`await next()` 前后），不用拆两个钩子 |
| `@UsePipes(...)` | `input` 声明（框架内置） | 转换 + 校验一体 |
| `ExceptionFilter` | 抛 `HttpError` + `errors` 钩子 | 错误→状态码有固定映射表（[10](./10-http-routing.md) §3） |
| `@nestjs/config` + `ConfigService` | `defineConfig({…})` + env 覆盖 | schema 校验在启动期（[14 配置与密钥](./14-config-env.md)） |
| `@nestjs/event-emitter` / `CqrsModule` | Actor 消息 + `tell`/`ask`；`@actor/data` 的事件溯源 | 消息即边界，不需要额外的事件总线插件 |
| `@nestjs/testing` + `supertest` | `node --test` + 真 app | 见 [17 测试](./17-testing.md) |
| `@nestjs/microservices`（Redis/Kafka transport） | 集群能力（gossip + TCP 网关）或自建队列 | 单进程内的并发正确性先解决，再谈跨进程 |

## 2. 为什么这里**没有装饰器**（这一节是正面回答，不是回避）

三条事实，都可以自己复现（下面 §4 的验证块就跑给你看）：

1. **Node 原生剥离不支持装饰器**：本项目走"源码直接跑"（`.ts` 由 Node 剥离类型执行），
   而装饰器需要**真实转译**（改写成 `__decorate(...)` 调用），不属于"剥离"能做的事。
   实测：`node dec.ts`（含 `@Injectable()`）直接抛 `SyntaxError`，`--experimental-transform-types` 也不行。
2. **`tsc` 其实能编译装饰器** —— 但那意味着**必须先构建再运行**（产物是 JS），
   与本项目"改完源码立刻生效、CI 里没有'忘了编译'这种失败模式"的取舍冲突。
   装饰器不是被语言禁止，而是**与零构建这条主线不兼容**（[部署与构建 §1](./22-deploy-and-build.md)）。
   顺带一提：`enum`、`namespace`、参数属性确实被 `erasableSyntaxOnly` 挡住（那些是真·不可擦除语法）。
3. **换来的东西很具体**：零构建、零运行时依赖、启动期就能校验装配。
   代价就是不能把 `@Injectable()` 那种"靠元数据自动接线"的写法搬进来。

**所以替代方案是"把装饰器想表达的东西写成数据"**：

| 装饰器表达 | 这里写成 |
|---|---|
| 路由路径与方法 | `get('/notes/:id', c)` 这样的路由声明 |
| 输入校验（DTO） | `input: { id: { type: 'number', min: 1 } }` |
| 鉴权 | 中间件阶段 + 控制器上的 `auth` 声明 |
| 依赖注入 | `providers` 的键 + `ctx.get('name')` / Actor 的 `deps: ['name']` |
| 横切关注点（拦截器） | `atPre` / `atPost`（`await next()` 前后） |
| 模块装配 | `defineModule({…})` 显式列出 |

好处也具体：**一切都能在启动期检查**（输入键有没有来源、provider 有没有缺依赖、路由有没有重复、
保留名有没有撞车），报错发生在 `start()`，而不是第一次请求。

## 3. 一段真实对照

NestJS：

```ts
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) { return this.notes.findOne(id); }
}
```

本文档：

```ts
export const notes = {
  findOne: defineController({
    input: { id: { type: 'number', min: 1 } },     // 校验 + 转换都在声明里（等价于 ParseIntPipe + DTO）
    handle: (input, ctx) => (ctx.get('notes') as NotesService).findOne(Number(input.id)),
  }),
};

export default defineModule({
  name: 'notes',
  providers: { notes: (deps) => createNotesService(deps) },   // 等价于构造函数注入
  routes: defineRoutes([get('/notes/:id', notes.findOne)]),  // 等价于 @Controller + @Get
});
```

## 4. 跑一遍（CI 真执行）

这个块证明两件事：① 装饰器确实**不被支持**（用仓库自己的 tsc 与 `erasableSyntaxOnly` 真编译一次，
必须报错）；② 装饰器想表达的那几件事（校验、鉴权、横切）用声明式 API 都能做到并真跑通。

```js verify
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// ---------- ① 装饰器：Node 直跑会失败；tsc 能编译（要构建）----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-decorator-'));
try {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(dir, 'with-decorator.ts'),
    [
      'function Injectable(): ClassDecorator { return () => undefined; }',
      '@Injectable()',
      'export class NotesService {}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          noEmit: true,
          experimentalDecorators: true,
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  );

  // (a) Node 直接跑（本项目的默认路线）：必须失败 —— 这就是"不支持装饰器"的真实含义
  let nodeFailed = false;
  let nodeOutput = '';
  try {
    await run(process.execPath, ['with-decorator.ts'], { cwd: dir });
  } catch (error) {
    nodeFailed = true;
    nodeOutput = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`;
  }
  assert.ok(nodeFailed, 'Node 直接跑含装饰器的 .ts 必须失败（零构建路线的硬约束）');
  assert.match(nodeOutput, /SyntaxError|Unsupported|Invalid or unexpected token/i, `报错应当指向装饰器：${nodeOutput}`);

  // (b) tsc 能编译它 —— 代价是"必须先构建再运行"，与本项目的零构建主线冲突（如实写出来）
  const tsc = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  await run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: dir });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- ② 装饰器想表达的事，用声明式 API 都能做到 ----------
const repo = `file://${process.cwd()}/`;
const appLayer = await import(`${repo}packages/app/src/index.ts`);
const webLayer = await import(`${repo}packages/web/src/index.ts`);
const { createApp, defineApp, defineModule } = appLayer;
const { HttpError, atAuth, defineController, defineRoutes, get, httpPlugin } = webLayer;

// 等价于 @Injectable() 的 service：显式 provider
const createNotesService = () => ({
  findOne: (id) => (id === 1 ? { id: 1, title: 'first' } : null),
});

// 等价于 DTO + ParseIntPipe：校验写在 input 里
const controller = defineController({
  input: { id: { type: 'number', min: 1 } },
  async handle(input, ctx) {
    const found = (ctx.get('notes')).findOne(Number(input.id));
    if (found === null) throw new HttpError(404, 'note not found');
    return found;
  },
});

// 等价于 @UseGuards：阶段中间件（这里用请求头当 token，真实项目用 authPlugin，见 13 鉴权）
const requireToken = atAuth(async (ctx, next) => {
  if (ctx.header('x-token') !== 'secret') throw new HttpError(401, 'unauthorized');
  return next();
});

const http = httpPlugin({ port: 0, accessLog: false });
const app = createApp(
  defineApp({
    modules: [
      defineModule({
        name: 'notes',
        providers: { notes: () => createNotesService() },
        middleware: [requireToken],
        routes: defineRoutes([get('/notes/:id', controller)]),
      }),
    ],
    plugins: [http],
  }),
  { configDir: '', env: {}, kernel: { logger: false } },
);

await app.start();
try {
  const base = `http://127.0.0.1:${String(http.address()?.port)}`;

  assert.strictEqual((await fetch(`${base}/notes/1`)).status, 401, '没 token → 401（等价于 Guard）');
  assert.strictEqual((await fetch(`${base}/notes/1`, { headers: { 'x-token': 'secret' } })).status, 200);
  assert.deepStrictEqual(await (await fetch(`${base}/notes/1`, { headers: { 'x-token': 'secret' } })).json(), { id: 1, title: 'first' });

  // ParseIntPipe 的等价物：校验 + 转换都在声明里（`abc` 不是 number → 400）
  assert.strictEqual((await fetch(`${base}/notes/abc`, { headers: { 'x-token': 'secret' } })).status, 400);
  // ExceptionFilter 的等价物：HttpError(404) 直接映射成 404
  assert.strictEqual((await fetch(`${base}/notes/2`, { headers: { 'x-token': 'secret' } })).status, 404);

  console.log('nestjs-mapping-ok');
} finally {
  await app.stop();
}
```

## 下一步
- 中间件阶段与作用域：[10 路由与请求](./10-http-routing.md) §4、[13 鉴权](./13-auth.md)
- 有状态的部分（NestJS 里通常靠单例 + 锁）：[12 Actor 与状态](./12-actors-state.md)
- 从 Express 过来（更简单的迁移场景）：[23 从 Express 过来](./23-from-express.md)
