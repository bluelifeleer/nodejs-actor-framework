export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ActorStatus = {
  readonly id: string; readonly state?: string; readonly isolation?: string; readonly mailbox?: number;
  readonly received?: number; readonly handled?: number; readonly failed?: number; readonly restarted?: number;
  readonly deadLettered?: number; readonly recovered?: number; readonly lastError?: string;
};
export type LogEntry = {
  readonly ts: number; readonly level: LogLevel; readonly source?: string; readonly event?: string;
  readonly message?: string; readonly requestId?: string; readonly actorId?: string; readonly detail?: unknown;
};
export type IngestMessage = Record<string, unknown>;
