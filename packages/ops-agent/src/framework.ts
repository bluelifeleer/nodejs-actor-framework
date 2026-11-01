import type { ActorStatus } from './protocol.ts';

export interface DeadLetterEntry {
  readonly ts?: number; readonly actorId: string; readonly reason?: string;
  readonly retryCount?: number; readonly preview?: string;
}

export interface FrameworkSnapshot { readonly actors: ActorStatus[]; readonly deadLetters?: number; readonly deadLetterEntries?: DeadLetterEntry[]; readonly peers?: Array<{ key: string; nodeId: string }>; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function collectFrameworkSnapshot(system: unknown): FrameworkSnapshot {
  if (!isRecord(system)) return { actors: [] };
  const actors: ActorStatus[] = [];
  try {
    const cells = system['cells'];
    if (cells instanceof Map) {
      for (const [id, raw] of cells) {
        if (!isRecord(raw)) continue;
        const counters = isRecord(raw['counters']) ? raw['counters'] : {};
        const mailbox = isRecord(raw['mailbox']) ? Number(raw['mailbox']['size'] ?? 0) : 0;
        const parent = isRecord(raw['parent']) ? raw['parent'] : null;
        const definition = isRecord(raw['definition']) ? raw['definition'] : null;
        actors.push({
          id: String(raw['path'] ?? id),
          ...(parent !== null && typeof parent['path'] === 'string' ? { parentId: parent.path } : {}),
          ...(definition !== null && typeof definition['kind'] === 'string' ? { kind: definition.kind } : {}),
          ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
          ...(typeof raw['isolation'] === 'string' ? { isolation: raw['isolation'] } : {}),
          ...(typeof raw['lastError'] === 'string' ? { lastError: raw['lastError'] } : {}),
          ...(typeof raw['lastRestartReason'] === 'string' ? { restartReason: raw['lastRestartReason'] } : {}),
          mailbox,
          ...(typeof counters['received'] === 'number' ? { received: counters['received'] } : {}),
          ...(typeof counters['handled'] === 'number' ? { handled: counters['handled'] } : {}),
          ...(typeof counters['failed'] === 'number' ? { failed: counters['failed'] } : {}),
          ...(typeof counters['restarted'] === 'number' ? { restarted: counters['restarted'] } : {}),
          ...(typeof counters['deadLettered'] === 'number' ? { deadLettered: counters['deadLettered'] } : {}),
        });
      }
    }
  } catch { /* never break the app */ }
  let deadLetters: number | undefined;
  try {
    const stats = system['stats'];
    if (typeof stats === 'function') {
      const value = (stats as () => unknown).call(system);
      if (isRecord(value)) deadLetters = Number(value['deadLettered'] ?? value['deadLetters'] ?? 0);
    }
  } catch { /* ignore */ }
  let deadLetterEntries: DeadLetterEntry[] | undefined;
  try {
    const raw = system['deadLetters'];
    if (Array.isArray(raw)) {
      deadLetterEntries = raw.slice(-50).map((item) => {
        const entry = isRecord(item) ? item : {};
        const payload = entry['payload'];
        const preview = typeof payload === 'string'
          ? payload.slice(0, 512)
          : payload === undefined ? undefined : JSON.stringify(payload).slice(0, 512);
        return {
          ...(typeof entry['ts'] === 'number' ? { ts: entry['ts'] } : {}),
          actorId: String(entry['path'] ?? entry['actorId'] ?? 'unknown'),
          ...(typeof entry['error'] === 'string' ? { reason: entry['error'] } : typeof entry['reason'] === 'string' ? { reason: entry['reason'] } : {}),
          ...(typeof entry['retryCount'] === 'number' ? { retryCount: entry['retryCount'] } : {}),
          ...(preview === undefined ? {} : { preview }),
        };
      });
      deadLetters = deadLetterEntries.length;
    }
  } catch { /* never break the app */ }
  let peers: Array<{ key: string; nodeId: string }> | undefined;
  try {
    const list = system['listPeers'];
    if (typeof list === 'function') {
      const value = (list as () => unknown).call(system);
      if (Array.isArray(value)) peers = value.filter(isRecord).map((item) => ({ key: String(item['key'] ?? ''), nodeId: String(item['nodeId'] ?? '') }));
    }
  } catch { /* ignore */ }
  return { actors, ...(deadLetters === undefined ? {} : { deadLetters }), ...(deadLetterEntries === undefined ? {} : { deadLetterEntries }), ...(peers === undefined ? {} : { peers }) };
}

export function summarizeActors(actors: readonly ActorStatus[]): { total: number; running: number; failed: number; byState: Record<string, number>; top: ActorStatus[] } {
  const byState: Record<string, number> = {};
  for (const actor of actors) byState[actor.state ?? 'unknown'] = (byState[actor.state ?? 'unknown'] ?? 0) + 1;
  return {
    total: actors.length,
    running: actors.filter((actor) => actor.state === 'running' || actor.state === 'online').length,
    failed: actors.filter((actor) => actor.state === 'failed' || actor.state === 'crashed').length,
    byState,
    top: [...actors].sort((a, b) => (b.mailbox ?? 0) - (a.mailbox ?? 0)).slice(0, 50),
  };
}
