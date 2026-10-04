/**
 * Type definitions for metric-based alerting over the framework's /metrics.
 */

export interface ParsedMetrics {
  types: Record<string, string>;
  help: Record<string, string>;
  samples: Array<{ name: string; labels: Record<string, string>; value: number }>;
}

export function parsePrometheusText(text: string): ParsedMetrics;
export function sumSamples(parsed: ParsedMetrics, metric: string, labelFilter?: Record<string, string> | null): number | null;
export function parseDuration(value: string | number | undefined): number;

export type AlertCondition = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'rate>' | 'rate>=' | 'rate<' | 'rate<=' | 'increase>' | 'increase>=' | 'increase<' | 'increase<=';

export interface AlertRule {
  name: string;
  metric: string;
  condition?: AlertCondition;
  threshold?: number;
  /** Only with `rate*`/`increase*`: exact label match filter. */
  labels?: Record<string, string>;
  /** How long the condition must hold before firing (e.g. '10s', '1m', 5000). */
  for?: string | number;
  /** Keep an alert firing this long after the condition clears (anti-flap). */
  resolveFor?: string | number;
  severity?: 'info' | 'warning' | 'critical' | string;
  summary?: string;
}

export interface AlertEvent {
  status: 'pending' | 'firing' | 'resolved' | 'pending_cleared';
  rule: AlertRule;
  value: number | null;
  at: number;
  summary: string;
}

export interface AlertNotifier {
  name: string;
  send(event: AlertEvent): void | Promise<void>;
}

export interface AlertManagerOptions {
  /** Scrape `url`, or read an in-process `snapshot` (raw text or parsed). */
  source: { url?: string; timeoutMs?: number; snapshot?: () => string | ParsedMetrics | Promise<string | ParsedMetrics> };
  rules: AlertRule[];
  notifiers?: AlertNotifier[];
  intervalMs?: number;
}

export interface AlertStatus {
  name: string;
  severity: string;
  metric: string;
  condition: string;
  threshold: number;
  status: 'inactive' | 'pending' | 'firing' | 'resolved';
  value: number | null;
  since: number | null;
  summary: string;
}

export class AlertManager {
  constructor(options: AlertManagerOptions);
  readonly rules: AlertRule[];
  evaluateOnce(now?: number): Promise<AlertEvent[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { evaluations: number; lastError: string | null; alerts: AlertStatus[] };
  on(event: 'pending' | 'pending_cleared' | 'firing' | 'resolved', listener: (event: AlertEvent) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'notify_error', listener: (info: { notifier: string; error: Error; event: AlertEvent }) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export function evaluateRule(
  rule: Pick<AlertRule, 'name' | 'metric' | 'condition' | 'threshold' | 'labels'> & { condition: string },
  parsed: ParsedMetrics & { _now?: number },
  previous: { value: number; at: number } | null,
): { value: number | null; ok: boolean };

export function consoleNotifier(options?: { log?: (line: string) => void }): AlertNotifier;
export function webhookNotifier(url: string, options?: { name?: string; timeoutMs?: number }): AlertNotifier;

/** Ready-made rules for the game-server shape (mailbox, throttling, dead letters, crashes). */
export function defaultGameRules(): AlertRule[];
