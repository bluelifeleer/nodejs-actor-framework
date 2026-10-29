import type { ActorStatus } from './protocol.ts';

export interface FrameworkSnapshot { readonly actors: ActorStatus[]; readonly deadLetters?: number; }

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
        actors.push({
          id: String(raw['path'] ?? id),
          ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
          ...(typeof raw['isolation'] === 'string' ? { isolation: raw['isolation'] } : {}),
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
  return { actors, ...(deadLetters === undefined ? {} : { deadLetters }) };
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
