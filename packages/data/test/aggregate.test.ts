import { test } from 'node:test';
import assert from 'node:assert';

import {
  AggregateDefinitionError,
  AggregateEvolutionError,
  defaultCommandOf,
  defineAggregate,
  defineEventSchema,
  UnknownCommandError,
  type AggregateContext,
  type AggregateDefinition,
  type AggregateEvent,
} from '../src/index.ts';

interface OrderState {
  status: string;
  totalCents: number;
}

interface OrderSpec {
  name?: string;
  events?: readonly ReturnType<typeof defineEventSchema>[];
  initialState?: () => OrderState;
  applyEvent?: (state: OrderState, event: AggregateEvent) => OrderState;
  commands?: Record<string, (cmd: unknown, state: OrderState) => unknown>;
}

function orderSpec(overrides: OrderSpec = {}) {
  return defineAggregate<OrderState>({
    name: 'Order',
    initialState: () => ({ status: 'created', totalCents: 0 }),
    events: [defineEventSchema({ type: 'ItemAdded', version: 2, upcasts: [{ from: 1, to: 2, up: (e) => e }] })],
    applyEvent: (state, event) =>
      event.type === 'ItemAdded' ? { ...state, totalCents: state.totalCents + (event.price as number) } : state,
    commands: {
      addItem: (cmd, state) => {
        const price = (cmd as { price: number }).price;
        if (state.status !== 'created') throw new Error('order already confirmed');
        if (price <= 0) throw new Error('price must be positive');
        return { type: 'ItemAdded', price };
      },
    },
    ...overrides,
  } as never);
}

/**
 * 最小内核替身：**忠实照搬内核的行为**——`persist` 之后立刻把同一个对象喂给 `applyEvent`
 * （第 1 步建立的不变量：写入期与重放期走同一条管线）。默认**不接** evolution，
 * 于是正好覆盖"用户忘了接 evolution"这条最容易踩的路径。
 */
function harness(definition: AggregateDefinition<OrderState>, wireEvolution = false) {
  const persisted: unknown[] = [];
  const holder: { state: OrderState } = { state: definition.state() };
  const upcast = wireEvolution ? definition.evolution?.upcast : undefined;
  const ctx: AggregateContext = {
    persist: async (event: unknown) => {
      persisted.push(event);
      definition.applyEvent.call(holder, (upcast ? upcast(event) : event) as AggregateEvent);
      return event;
    },
  };
  return { ctx, holder, persisted };
}

test('aggregate: 命令产出的事件被套上信封（type/version/payload），版本取自 schema', async () => {
  const Order = orderSpec();
  const h = harness(Order);

  const returned = await Order.receive.call(h.holder, { type: 'addItem', price: 100 }, h.ctx);

  assert.strictEqual(h.persisted.length, 1);
  const envelope = h.persisted[0] as { type: string; version: number; payload: unknown; eventId: string };
  assert.strictEqual(envelope.type, 'ItemAdded');
  assert.strictEqual(envelope.version, 2, '版本来自 events schema 的当前版本');
  assert.deepStrictEqual(envelope.payload, { type: 'ItemAdded', price: 100 });
  assert.match(envelope.eventId, /^evt-/);

  assert.deepStrictEqual(h.holder.state, { status: 'created', totalCents: 100 }, '状态由事件推导');
  assert.deepStrictEqual(returned, { status: 'created', totalCents: 100 }, '返回命令执行后的状态');
  assert.notStrictEqual(returned, h.holder.state, '不得把活状态交出去（浅拷贝）');
});

test('aggregate: 没接 evolution 时，当前版本的事件仍能工作（自动拆信封）', async () => {
  const Order = orderSpec();
  const h = harness(Order, false);
  await Order.receive.call(h.holder, { type: 'addItem', price: 5 }, h.ctx);
  assert.deepStrictEqual(h.holder.state, { status: 'created', totalCents: 5 });
});

test('aggregate: 没接 evolution 却读到旧版本事件 → 明确报错（不静默用错结构）', () => {
  const Order = orderSpec();
  const h = harness(Order, false);
  assert.throws(
    () => Order.applyEvent.call(h.holder, { type: 'ItemAdded', version: 1, payload: { type: 'ItemAdded', price: 1 } } as never),
    (err: unknown) => {
      assert.ok(err instanceof AggregateEvolutionError);
      assert.strictEqual(err.eventType, 'ItemAdded');
      assert.strictEqual(err.found, 1);
      assert.strictEqual(err.expected, 2);
      assert.match(err.message, /evolution/);
      return true;
    },
  );
});

test('aggregate: 接了 evolution 时旧版本事件被升级后应用', async () => {
  const Order = orderSpec({
    // v1 的 price 是"元"，v2 改成"分"：升级链负责换算
    events: [
      defineEventSchema({
        type: 'ItemAdded',
        version: 2,
        upcasts: [{ from: 1, to: 2, up: (e) => ({ ...e, price: (e.price as number) * 100 }) }],
      }),
    ],
  });
  const h = harness(Order, true);
  // 模拟"重放一条 v1 旧事件"：内核会先 upcast，再把事件体交给 applyEvent
  const upgraded = Order.evolution?.upcast?.({
    type: 'ItemAdded',
    version: 1,
    payload: { type: 'ItemAdded', price: 3 },
  });
  Order.applyEvent.call(h.holder, upgraded as AggregateEvent);
  assert.deepStrictEqual(h.holder.state, { status: 'created', totalCents: 300 });
});

test('aggregate: 一个命令可以产出多个事件；不产出事件也合法', async () => {
  const Order = defineAggregate<OrderState>({
    name: 'Order',
    initialState: () => ({ status: 'created', totalCents: 0 }),
    applyEvent: (state) => state,
    commands: {
      two: () => [{ type: 'A' }, { type: 'B' }],
      none: () => undefined,
    },
  });
  const h = harness(Order);
  await Order.receive.call(h.holder, { type: 'two' }, h.ctx);
  assert.deepStrictEqual(
    (h.persisted as { type: string }[]).map((e) => e.type),
    ['A', 'B'],
  );
  assert.strictEqual((h.persisted[0] as { version: number }).version, 1, '未声明的类型按 v1 落盘');

  const h2 = harness(Order);
  const returned = await Order.receive.call(h2.holder, { type: 'none' }, h2.ctx);
  assert.deepStrictEqual(h2.persisted, []);
  assert.deepStrictEqual(returned, h2.holder.state);
});

test('aggregate: 未知命令 / 取不到命令名 → 明确报错（含已声明命令）', async () => {
  const Order = orderSpec();
  const h = harness(Order);

  await assert.rejects(
    () => Order.receive.call(h.holder, { type: 'nope' }, h.ctx),
    (err: unknown) => {
      assert.ok(err instanceof UnknownCommandError);
      assert.strictEqual(err.command, 'nope');
      assert.deepStrictEqual(err.known, ['addItem']);
      assert.match(err.message, /没有命令 'nope'/);
      assert.match(err.message, /已声明：addItem/);
      return true;
    },
  );

  await assert.rejects(
    () => Order.receive.call(h.holder, { payload: 1 }, h.ctx),
    (err: unknown) => err instanceof UnknownCommandError && err.command === null,
  );
});

test('aggregate: 命令拿到的状态是顶层冻结的副本——"直接改状态"当场失败，真实状态不受影响', async () => {
  const Order = defineAggregate<OrderState>({
    name: 'Order',
    initialState: () => ({ status: 'created', totalCents: 0 }),
    applyEvent: (state) => state,
    commands: {
      sneaky: (_cmd, state) => {
        (state as unknown as { totalCents: number }).totalCents = 999; // 不应该这么做
        return { type: 'Noop' };
      },
    },
  });
  const h = harness(Order);
  await assert.rejects(() => Order.receive.call(h.holder, { type: 'sneaky' }, h.ctx), TypeError);
  assert.strictEqual(h.holder.state.totalCents, 0, '真实状态没有被污染');
});

test('aggregate: 事件必须自带字符串 type（信封的 type 只用于查表）', async () => {
  const bad = defineAggregate<OrderState>({
    name: 'Order',
    initialState: () => ({ status: 'created', totalCents: 0 }),
    applyEvent: (state) => state,
    commands: {
      missingType: () => ({ price: 1 }) as never,
      notAnObject: () => 42 as never,
      inArray: () => [{ type: 'A' }, null] as never,
    },
  });
  const h = harness(bad);
  await assert.rejects(() => bad.receive.call(h.holder, { type: 'missingType' }, h.ctx), /缺少字符串 type 字段/);
  await assert.rejects(() => bad.receive.call(h.holder, { type: 'notAnObject' }, h.ctx), /不是对象/);
  await assert.rejects(() => bad.receive.call(h.holder, { type: 'inArray' }, h.ctx), /第 2 个事件不是对象/);
});

test('aggregate: 定义写错在构造期就报错', () => {
  assert.throws(() => defineAggregate({} as never), /initialState 必须是函数/);
  assert.throws(
    () => defineAggregate({ initialState: () => ({}), applyEvent: 1, commands: {} } as never),
    (err: unknown) => {
      assert.ok(err instanceof AggregateDefinitionError);
      assert.ok(err.issues.some((i) => /applyEvent 必须是纯函数/.test(i)));
      assert.ok(err.issues.some((i) => /commands 不能为空/.test(i)));
      return true;
    },
  );
  assert.throws(
    () => defineAggregate({ initialState: () => ({}), applyEvent: (s: object) => s, commands: { a: 1 } } as never),
    /命令 'a' 的处理器必须是函数/,
  );
  assert.throws(
    () =>
      defineAggregate({
        initialState: () => ({}),
        applyEvent: (s: object) => s,
        commands: { a: () => ({ type: 'A' }) },
        commandOf: 'nope',
      } as never),
    /commandOf 必须是函数/,
  );
});

test('aggregate: 元数据不可枚举（内核的 unknown-keys 拼写检查不会被误触发）', () => {
  const Order = orderSpec();
  assert.deepStrictEqual(Object.keys(Order).sort(), ['applyEvent', 'receive', 'state'], '暴露给内核的键只有 handler 名');
  for (const metadata of ['name', 'events', 'registry', 'evolution']) {
    assert.ok(metadata in Order, `${metadata} 应可通过属性访问到`);
  }
  assert.strictEqual(Order.name, 'Order');
  assert.strictEqual(Order.evolution !== null, true);
  assert.strictEqual(Order.registry.currentVersion('ItemAdded'), 2);
});

test('aggregate: 没声明 events 时没有 evolution（不该凭空造一个恒等演进）', () => {
  const Plain = defineAggregate<{ n: number }>({
    initialState: () => ({ n: 0 }),
    applyEvent: (state) => state,
    commands: { noop: () => undefined },
  });
  assert.strictEqual(Plain.evolution, null);
  assert.deepStrictEqual(Plain.events, []);
  assert.strictEqual(Plain.name, 'Aggregate', '默认名字');
});

test('aggregate: commandOf 可自定义；默认取 command 再取 type', async () => {
  assert.strictEqual(defaultCommandOf({ command: 'a', type: 'b' }), 'a');
  assert.strictEqual(defaultCommandOf({ type: 'b' }), 'b');
  assert.strictEqual(defaultCommandOf({}), null);
  assert.strictEqual(defaultCommandOf('a'), null);
  assert.strictEqual(defaultCommandOf(null), null);

  const Custom = defineAggregate<{ n: number }>({
    name: 'Custom',
    initialState: () => ({ n: 0 }),
    applyEvent: (state) => state,
    commands: { ping: () => ({ type: 'Ping' }) },
    commandOf: (msg) => (msg as { cmd?: string }).cmd ?? null,
  });
  const persisted: unknown[] = [];
  await Custom.receive.call(
    { state: Custom.state() },
    { cmd: 'ping' },
    { persist: async (e: unknown) => void persisted.push(e) },
  );
  assert.strictEqual((persisted[0] as { type: string }).type, 'Ping');
});

test('aggregate: 生命周期钩子被原样转交内核', async () => {
  const calls: string[] = [];
  const WithHooks = defineAggregate<{ n: number }>({
    initialState: () => ({ n: 0 }),
    applyEvent: (state) => state,
    commands: { noop: () => undefined },
    preStart: () => calls.push('preStart'),
    postRecover: () => calls.push('postRecover'),
    postStop: () => calls.push('postStop'),
    preRestart: (reason) => calls.push(`preRestart:${String(reason)}`),
  });
  await WithHooks.preStart?.({});
  await WithHooks.postRecover?.({});
  await WithHooks.postStop?.({});
  await WithHooks.preRestart?.('boom', {}, {});
  assert.deepStrictEqual(calls, ['preStart', 'postRecover', 'postStop', 'preRestart:boom']);
});

test('aggregate: applyEvent 是纯函数——不改输入，返回新状态', () => {
  const Order = orderSpec();
  const before = { status: 'created', totalCents: 0 };
  const holder = { state: before };
  Order.applyEvent.call(holder, { type: 'ItemAdded', price: 50 });
  assert.deepStrictEqual(before, { status: 'created', totalCents: 0 }, '输入状态不被改写');
  assert.deepStrictEqual(holder.state, { status: 'created', totalCents: 50 });
});

test('aggregate: 每个实例拿到独立的初始状态（不能共享同一个对象）', () => {
  const Order = orderSpec();
  const a = Order.state();
  const b = Order.state();
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a, b);
  a.totalCents = 1;
  assert.strictEqual(b.totalCents, 0);
});
