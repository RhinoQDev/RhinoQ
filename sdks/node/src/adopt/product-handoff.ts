import { createHash } from 'node:crypto';

export interface RhinoQTaskProductHandoffInput {
  tasks: readonly { name: string; runtime: string; mode: 'single' | 'fanout' }[];
  ownerAPIPath?: string;
  taskCenterPath?: string;
  workbenchPath?: string;
  ownerIdentityConfigured: boolean;
  operatorGateConfigured: boolean;
}

export interface RhinoQTaskProductHandoff {
  schemaVersion: 1;
  kind: 'rhinoq-task-product-handoff';
  fingerprint: string;
  tasks: readonly { name: string; runtime: string; mode: 'single' | 'fanout' }[];
  surfaces: readonly {
    id: 'owner-task-api' | 'task-center' | 'workbench';
    path: string;
    status: 'mounted' | 'configuration-required';
    requirement?: string;
  }[];
  terminal: {
    watch: string;
    inspect: string;
    open: string;
  };
  acceptance: readonly {
    id: string;
    status: 'ready' | 'application-decision';
    verify: string;
  }[];
  note: 'handoff describes generated product plumbing; authentication, business handlers, verification and effect policy remain application-owned';
}

/** Deterministic handoff shared by generators, docs and CI. */
export function compileRhinoQTaskProductHandoff(input: RhinoQTaskProductHandoffInput): RhinoQTaskProductHandoff {
  if (!input?.tasks?.length) throw new TypeError('Task product handoff requires at least one Task');
  const tasks = input.tasks.map((task) => {
    if (!task.name?.trim() || !task.runtime?.trim() || (task.mode !== 'single' && task.mode !== 'fanout')) throw new TypeError('Task product handoff tasks require name, runtime and single/fanout mode');
    return { name: task.name.trim(), runtime: task.runtime.trim(), mode: task.mode };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const ownerAPIPath = safePath(input.ownerAPIPath ?? '/tasks', 'ownerAPIPath');
  const taskCenterPath = safePath(input.taskCenterPath ?? '/task-center', 'taskCenterPath');
  const workbenchPath = safePath(input.workbenchPath ?? '/rhinoq', 'workbenchPath');
  const canonical = { tasks, ownerAPIPath, taskCenterPath, workbenchPath, ownerIdentityConfigured: input.ownerIdentityConfigured, operatorGateConfigured: input.operatorGateConfigured };
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'rhinoq-task-product-handoff' as const,
    fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    tasks: Object.freeze(tasks),
    surfaces: Object.freeze([
      Object.freeze({ id: 'owner-task-api' as const, path: ownerAPIPath, status: input.ownerIdentityConfigured ? 'mounted' as const : 'configuration-required' as const, ...(input.ownerIdentityConfigured ? {} : { requirement: 'Map authenticated request identity to owner and tenant.' }) }),
      Object.freeze({ id: 'task-center' as const, path: taskCenterPath, status: input.ownerIdentityConfigured ? 'mounted' as const : 'configuration-required' as const, ...(input.ownerIdentityConfigured ? {} : { requirement: 'Mount after the owner Task API is authenticated.' }) }),
      Object.freeze({ id: 'workbench' as const, path: workbenchPath, status: input.operatorGateConfigured ? 'mounted' as const : 'configuration-required' as const, ...(input.operatorGateConfigured ? {} : { requirement: 'Provide an explicit operator authentication/authorization gate.' }) }),
    ]),
    terminal: Object.freeze({ watch: 'npx rhinoq watch', inspect: 'npx rhinoq inspect <task-id>', open: 'npx rhinoq open <task-id>' }),
    acceptance: Object.freeze([
      Object.freeze({ id: 'runtime-binding', status: 'ready' as const, verify: 'npx rhinoq doctor' }),
      Object.freeze({ id: 'owner-identity', status: input.ownerIdentityConfigured ? 'ready' as const : 'application-decision' as const, verify: 'Exercise an owner A / owner B not-found boundary test.' }),
      Object.freeze({ id: 'operator-gate', status: input.operatorGateConfigured ? 'ready' as const : 'application-decision' as const, verify: 'Request Workbench without operator authorization and expect refusal.' }),
      Object.freeze({ id: 'business-verification', status: 'application-decision' as const, verify: 'npx rhinoq verify add <rule>' }),
      Object.freeze({ id: 'effect-policy', status: 'application-decision' as const, verify: 'Review every Safety Compiler external-effect diagnostic.' }),
    ]),
    note: 'handoff describes generated product plumbing; authentication, business handlers, verification and effect policy remain application-owned' as const,
  });
}

function safePath(value: string, name: string): string {
  if (!/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/.test(value)) throw new TypeError(`${name} must be an absolute path without a trailing slash`);
  return value;
}
