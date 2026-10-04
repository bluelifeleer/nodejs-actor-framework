/**
 * Compile-only test for the access-layer and alerting modules
 * (`npm run typecheck`). Exercises the documented public API.
 */
import {
  WebSocketServer,
  connect,
  TokenAuthority,
  tokenFromRequest,
  type WebSocketConnection,
  type ClientConnection,
  type VerifiedToken,
} from 'nodejs-actor-framework/src/ops/index.ts';
import {
  AlertManager,
  parsePrometheusText,
  consoleNotifier,
  webhookNotifier,
  defaultGameRules,
  type AlertEvent,
  type AlertStatus,
} from 'nodejs-actor-framework/src/obs/alerting.ts';

export async function accessLayer(): Promise<void> {
  // No Node type packages here on purpose: pass the secret directly.
  const tokens = new TokenAuthority({ secret: 'a-long-enough-secret-for-tests', ttlMs: 60_000 });
  const issued = tokens.issue({ playerId: 'alice', claims: { role: 'gm' } });
  const verified: VerifiedToken | null = tokens.verify(issued.token);
  if (verified) void verified.playerId;
  tokens.revoke(issued.token);
  void tokenFromRequest({ url: '/game?token=x', headers: {} });

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/game',
    maxPayloadBytes: 64 * 1024,
    verifyClient(req) {
      const v = tokens.verify(tokenFromRequest(req) ?? '');
      return v ?? false;
    },
  });
  server.on('connection', (socket: WebSocketConnection, req) => {
    socket.playerId = (req.auth as { playerId: string } | null)?.playerId ?? null;
    socket.on('message', (data: string | Uint8Array, isBinary: boolean) => socket.send(data, { binary: isBinary }));
  });
  const port: number = await server.listen();

  const client: ClientConnection = await connect(`ws://127.0.0.1:${port}/game`, { tls: { rejectUnauthorized: false } });
  client.sendJson({ cmd: 'join' });
  const reply = await client.nextMessage(1000);
  void reply.isBinary;
  await client.nextPing(1000).catch(() => undefined);
  client.close(1000, 'done');
  await server.close();
}

export async function alerting(): Promise<void> {
  const parsed = parsePrometheusText('# TYPE actor_mailbox_depth_total gauge\nactor_mailbox_depth_total 1200\n');
  void parsed.types.actor_mailbox_depth_total;

  const manager = new AlertManager({
    source: { url: 'http://127.0.0.1:9464/metrics' },
    rules: defaultGameRules(),
    intervalMs: 5000,
    notifiers: [consoleNotifier(), webhookNotifier('http://127.0.0.1:9999/hook', { timeoutMs: 1000 })],
  });
  manager.on('firing', (event: AlertEvent) => void event.value);
  manager.on('resolved', (event: AlertEvent) => void event.rule.severity);
  const status = manager.status();
  const alerts: AlertStatus[] = status.alerts;
  void alerts.length;
  await manager.start();
  await manager.stop();
}
