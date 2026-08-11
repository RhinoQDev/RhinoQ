/** Read-only, provider-neutral runtime evidence for the operator Workbench. */
export type RuntimeHealthStatus = 'healthy' | 'degraded' | 'unknown' | 'unavailable';

export interface RuntimeScopeHealth {
  schemaVersion: 1;
  runtime: string;
  scope: string;
  status: RuntimeHealthStatus;
  observedAt: string;
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
    paused: boolean;
  };
  workers: { observable: boolean; connected?: number };
  policy?: { attempts?: number; backoff?: string; removeOnComplete?: boolean; removeOnFail?: boolean };
  reason?: 'runtime_unreachable' | 'worker_visibility_unavailable' | 'waiting_without_workers';
  dashboardURL?: string;
}

export interface RuntimeHealthReader {
  inspect(): Promise<RuntimeScopeHealth>;
}

export interface RuntimeJobLinkContext {
  runtime: string;
  scope: string;
  externalId: string;
}

export type RuntimeJobLink = (context: RuntimeJobLinkContext) => string | undefined;

/** Accept only browser-safe application-relative or HTTP(S) operator links. */
export function safeOperatorURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
