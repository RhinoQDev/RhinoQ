#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { installPostgresTaskProfile } from '../postgres/task-client.js';
import { TASK_SCHEMA_VERSION } from '../postgres/task-schema.js';
import { SDK_VERSION } from '../gateway/types.js';
import { resolveDatabaseConfig, type ResolvedDatabaseConfig } from './database-config.js';
import {
  NOTIFY_REGISTRY_VERSION,
  defaultSecretEnv,
  loadNotifyRegistry,
  notifyRegistryPath,
  resolveNotifyDestination,
  saveNotifyRegistry,
  type NotifyDestinationEntry,
  type NotifyKind,
} from '../notify/registry.js';
import { sendTestNotification } from '../notify/sender.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);
  switch (command) {
    case 'init': await init(); break;
    case 'verify': await verify(args); break;
    case 'doctor': await doctor(); break;
    case 'notify': await notify(args); break;
    case 'fixture': await fixture(args); break;
    case 'dev': await dev(args); break;
    case 'version': case '--version': case '-v': console.log(SDK_VERSION); break;
    case 'help': case '--help': case '-h': help(); break;
    default: fail(`unknown command ${JSON.stringify(command)}`, 'Run: npx rhinoq help');
  }
}

main().catch((error: unknown) => {
  if (!(error instanceof Error && error.message === '__reported__')) {
    console.error(`FAIL ${safe(error)}\nNEXT ${nextAction(error)}`);
    process.exitCode = 1;
  }
});

function database(): ResolvedDatabaseConfig | undefined {
  return resolveDatabaseConfig(process.env);
}

// Every command that needs PostgreSQL fails the same way, and the NEXT action
// names both shapes. A project whose platform only hands out discrete variables
// used to read "DATABASE_URL is not set" as "RhinoQ needs a URL I do not have".
function requireDatabase(command: string): ResolvedDatabaseConfig {
  const resolved = database();
  if (!resolved) {
    fail(
      'no PostgreSQL connection in the environment',
      `Set RHINOQ_DATABASE_URL or DATABASE_URL, or set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (RHINOQ_DB_* also works), then run: npx rhinoq ${command}`,
    );
  }
  return resolved;
}

async function init(): Promise<void> {
  const root = resolve('.rhinoq');
  await mkdir(resolve(root, 'rules'), { recursive: true });
  const resolved = database();
  await writeNew(resolve(root, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    databaseEnv: resolved?.source ?? 'DATABASE_URL',
    taskProfileVersion: TASK_SCHEMA_VERSION,
  }, null, 2) + '\n');
  if (resolved) {
    const pool = new Pool({ ...resolved.pool, connectionTimeoutMillis: 5_000 });
    try { await installPostgresTaskProfile(pool); }
    finally { await pool.end(); }
    console.log(`PASS PostgreSQL detected at ${resolved.target} via ${resolved.source}; RhinoQ Task schema v${TASK_SCHEMA_VERSION} is current.`);
  } else {
    await writeNew(resolve('.env.rhinoq.example'), [
      '# Either a connection URL...',
      'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app',
      '',
      '# ...or discrete variables, which is what most managed providers hand out.',
      '# PGHOST=localhost',
      '# PGPORT=5432',
      '# PGUSER=postgres',
      '# PGPASSWORD=postgres',
      '# PGDATABASE=app',
      '# PGSSLMODE=require',
      '',
      'REDIS_URL=redis://localhost:6379',
      '',
    ].join('\n'));
    console.log('WARN no PostgreSQL connection detected; schema was not applied.');
    console.log('NEXT set DATABASE_URL, or PGHOST/PGDATABASE and friends, then run: npx rhinoq init');
  }
  const detected = await detectPackages();
  console.log(`PASS created ${root}`);
  console.log(`INFO PostgreSQL client: ${detected.pg ? 'detected' : 'missing'}; BullMQ: ${detected.bullmq ? 'detected' : 'not detected (optional)'}.`);
  console.log('NEXT add a verification: npx rhinoq verify add completed-report-has-output');
}

async function verify(args: string[]): Promise<void> {
  const action = args[0];
  if (action === 'add') {
    await addRule(args.slice(1));
    return;
  }
  if (action === 'apply') {
    await applyRule(args.slice(1));
    return;
  }
  if (action === 'run') {
    await runRule(args.slice(1));
    return;
  }
  if (action === 'delete') {
    await deleteRule(args.slice(1));
    return;
  }
  fail('verify requires `add`, `apply`, `run` or `delete`', 'Run: npx rhinoq verify add completed-report-has-output');
}

async function addRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  const path = resolve('.rhinoq', 'rules', `${name}.sql`);
  await mkdir(resolve('.rhinoq', 'rules'), { recursive: true });
  await writeNew(path, ruleTemplate());
  console.log(`PASS generated ${path}`);
  console.log(`NEXT edit table/column names, then apply it through the Go Gateway: npx rhinoq verify apply ${name} --subject-type report`);
}

async function applyRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  const options = parseRuleOptions(args.slice(1));
  const query = await readRule(name);
  const localError = validateLocalRuleQuery(query, true);
  if (localError) fail(`Rule file is invalid: ${localError}`, `Edit .rhinoq/rules/${name}.sql, then run: npx rhinoq doctor`);

  // Applying an existing Rule appends a new immutable version, and Findings
  // stay attached to the version that observed them. A silent bump therefore
  // cuts the history an operator was reading without telling anyone, so the
  // change is shown and a changed definition needs --force.
  const current = await readRemoteRule(name);
  if (current) {
    const changes = describeRuleChanges(current, query, options);
    if (changes.length === 0) {
      console.log(`KEEP Rule ${name}@v${current.version ?? '?'} already matches .rhinoq/rules/${name}.sql; nothing was applied.`);
      console.log(`NEXT run a bounded check: npx rhinoq verify run ${name}`);
      return;
    }
    console.log(`WARN Rule ${name} already exists at v${current.version ?? '?'} and this definition differs:`);
    for (const change of changes) console.log(`  ${change}`);
    console.log(`INFO applying registers v${(current.version ?? 0) + 1}. Findings recorded against ${name}@v${current.version ?? '?'} keep that version and will not be reopened.`);
    if (!options.force) {
      fail(`Rule ${name} already exists with a different definition`, `Review the diff above, then run: npx rhinoq verify apply ${name} --force`);
    }
  }

  const response = await gatewayRequest('/v1/rules', {
    method: 'POST',
    body: JSON.stringify({
      id: name,
      name: humanizeRuleName(name),
      scope: 'table',
      subjectType: options.subjectType,
      query,
      baselineAt: options.baselineAt,
      everyMs: options.everyMs,
      withinMs: options.withinMs,
      maxRows: options.maxRows,
      statementTimeoutMs: options.statementTimeoutMs,
      maxPlanCost: options.maxPlanCost,
      maxSeqScanRows: options.maxSeqScanRows,
    }),
  });
  const record = (response as { rule?: RuleResponse }).rule ?? response as RuleResponse;
  if (!record.id) fail('Gateway returned no Rule record', 'Check the Go Gateway logs and retry the apply command');
  if (record.status === 'draft') {
    await gatewayRequest(`/v1/rules/${encodeURIComponent(record.id)}/disable`, { method: 'POST' });
  }
  console.log(`PASS applied Rule ${record.id}@v${record.version ?? '?'}; status=disabled`);
  console.log(`NEXT run a bounded check: npx rhinoq verify run ${name}`);
}

async function runRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  const options = parseRuleOptions(args.slice(1), true);
  await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}/enable`, { method: 'POST' });
  let evaluation: RuleEvaluationResponse;
  try {
    evaluation = await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ subjectId: options.subjectId, cursor: options.cursor }),
    }) as RuleEvaluationResponse;
  } finally {
    await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}/disable`, { method: 'POST' }).catch(() => undefined);
  }
  const observations = Array.isArray(evaluation.observations) ? evaluation.observations : [];
  const violated = observations.filter((item) => item.status === 'violated');
  const unknown = observations.filter((item) => item.status === 'unknown');
  console.log(`PASS evaluated ${name}: ${observations.length} subject(s), ${violated.length} violated, ${unknown.length} unknown`);
  if (observations.length === 0) {
    console.log('INFO 0 subject matched. The Rule baseline may exclude older rows by design; to inspect existing data once, rerun verify apply with --baseline <ISO date>.');
  }
  for (const item of [...violated, ...unknown]) {
    const reason = item.reason ? ` · ${item.reason}` : '';
    console.log(`  ${item.status.toUpperCase()} ${item.subjectId}${reason}`);
    if (item.evidence) console.log(`    evidence: ${item.evidence}`);
  }
  if (evaluation.hasMore && evaluation.nextCursor) console.log(`NEXT resume with: npx rhinoq verify run ${name} --cursor ${evaluation.nextCursor}`);
}

// readRemoteRule returns the current Rule, or undefined when there is none.
// A Gateway that predates GET /v1/rules/{id} answers 404 the same way an
// unknown Rule does, so the caller treats both as "nothing to compare" rather
// than blocking an apply on a missing endpoint.
async function readRemoteRule(name: string): Promise<RuleWireRecord | undefined> {
  const response = await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}`, { method: 'GET' }, true);
  if (!response) return undefined;
  const record = (response as { rule?: RuleWireRecord }).rule ?? response as RuleWireRecord;
  return record?.id ? record : undefined;
}

// describeRuleChanges lists what an apply would alter. The query is reported
// line by line because "the query changed" is not something a reviewer can act
// on, and this is the moment the reviewer is present.
function describeRuleChanges(current: RuleWireRecord, query: string, options: RuleOptions): string[] {
  const changes: string[] = [];
  const compare = (label: string, before: unknown, after: unknown): void => {
    if (before === undefined || before === null) return;
    if (String(before) !== String(after)) changes.push(`${label}: ${String(before)} -> ${String(after)}`);
  };
  compare('subject type', current.subjectType, options.subjectType);
  compare('every', `${current.everyMs}ms`, `${options.everyMs}ms`);
  compare('within', `${current.withinMs}ms`, `${options.withinMs}ms`);
  compare('max rows', current.maxRows, options.maxRows);
  compare('statement timeout', `${current.statementTimeoutMs}ms`, `${options.statementTimeoutMs}ms`);
  compare('max plan cost', current.maxPlanCost, options.maxPlanCost);
  compare('max seq scan rows', current.maxSeqScanRows, options.maxSeqScanRows);
  changes.push(...queryDiff(current.query ?? '', query));
  return changes;
}

function queryDiff(before: string, after: string): string[] {
  const beforeLines = before.replace(/\n+$/, '').split('\n');
  const afterLines = after.replace(/\n+$/, '').split('\n');
  const changes: string[] = [];
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    const oldLine = beforeLines[index] ?? '';
    const newLine = afterLines[index] ?? '';
    if (oldLine === newLine) continue;
    if (oldLine) changes.push(`query line ${index + 1} - ${oldLine}`);
    if (newLine) changes.push(`query line ${index + 1} + ${newLine}`);
  }
  return changes;
}

// deleteRule previews by default. The Gateway computes the plan inside the
// transaction that would perform it, so what is printed here is what would
// actually be removed rather than a second query's opinion of it.
async function deleteRule(args: string[]): Promise<void> {
  const name = ruleName(args[0]);
  let purgeFindings = false;
  let apply = false;
  for (const raw of args.slice(1)) {
    if (raw === '--purge-findings') { purgeFindings = true; continue; }
    if (raw === '--apply') { apply = true; continue; }
    fail(`unknown delete option ${JSON.stringify(raw)}`, `Run: npx rhinoq verify delete ${name} --apply`);
  }
  const query = new URLSearchParams({
    purgeFindings: String(purgeFindings),
    dryRun: String(!apply),
  });
  const response = await gatewayRequest(`/v1/rules/${encodeURIComponent(name)}?${query}`, { method: 'DELETE' });
  const deletion = (response as { deletion?: RuleDeletionResponse }).deletion ?? {};
  console.log(`RhinoQ deletion plan for Rule ${name}`);
  console.log(`  definitions      ${deletion.versions?.length ?? 0} (v${(deletion.versions ?? []).join(',') || '—'})`);
  console.log(`  explain records  ${deletion.explanations ?? 0}`);
  console.log(`  schedules        ${deletion.schedules ?? 0}`);
  console.log(`  subject outcomes ${deletion.outcomes ?? 0}`);
  if (purgeFindings) {
    console.log(`  findings         ${deletion.findings ?? 0} (discarded)`);
    console.log(`  finding history  ${deletion.findingEvents ?? 0} (discarded)`);
  }
  if (!deletion.applied) {
    console.log('INFO nothing was deleted.');
    console.log(`NEXT perform this plan: npx rhinoq verify delete ${name} --apply`);
    return;
  }
  console.log(`PASS Rule ${name} deleted.`);
}

type RuleResponse = { id: string; version?: number; status?: string };
type RuleWireRecord = {
  id?: string;
  version?: number;
  status?: string;
  subjectType?: string;
  query?: string;
  everyMs?: number;
  withinMs?: number;
  maxRows?: number;
  statementTimeoutMs?: number;
  maxPlanCost?: number;
  maxSeqScanRows?: number;
};
type RuleDeletionResponse = {
  versions?: number[];
  explanations?: number;
  schedules?: number;
  outcomes?: number;
  findings?: number;
  findingEvents?: number;
  applied?: boolean;
};
type RuleEvaluationResponse = {
  observations?: Array<{ subjectId: string; status: string; reason?: string; evidence?: string }>;
  hasMore?: boolean;
  nextCursor?: string;
};

type RuleOptions = {
  subjectType: string;
  baselineAt: string;
  everyMs: number;
  withinMs: number;
  maxRows: number;
  statementTimeoutMs: number;
  maxPlanCost: number;
  maxSeqScanRows: number;
  subjectId: string;
  cursor: string;
  force: boolean;
};

function ruleName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) fail('rule name must be 2-63 lowercase letters, digits or dashes', 'Example: completed-report-has-output');
  return name;
}

function parseRuleOptions(args: string[], runOnly = false): RuleOptions {
  const options: RuleOptions = {
    subjectType: process.env.RHINOQ_RULE_SUBJECT_TYPE ?? 'report',
    baselineAt: new Date().toISOString(),
    everyMs: 5 * 60_000,
    withinMs: 0,
    maxRows: 500,
    statementTimeoutMs: 5_000,
    maxPlanCost: 100_000,
    maxSeqScanRows: 10_000,
    subjectId: '',
    cursor: '',
    force: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    // --force takes no value, so it must be recognised before the generic
    // "next argument is the value" step consumes the flag that follows it.
    if (raw === '--force') {
      if (runOnly) fail('--force is only valid for verify apply', `Run: npx rhinoq verify apply <rule-name> --force`);
      options.force = true;
      continue;
    }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    switch (key) {
      case '--subject-type': options.subjectType = requiredOption(key, value); break;
      case '--baseline': options.baselineAt = requiredOption(key, value); break;
      case '--every': options.everyMs = durationMs(requiredOption(key, value), key); break;
      case '--within': options.withinMs = durationMs(requiredOption(key, value), key); break;
      case '--max-rows': options.maxRows = positiveInteger(key, value); break;
      case '--statement-timeout': options.statementTimeoutMs = durationMs(requiredOption(key, value), key); break;
      case '--max-plan-cost': options.maxPlanCost = positiveNumber(key, value); break;
      case '--max-seq-scan-rows': options.maxSeqScanRows = positiveInteger(key, value); break;
      case '--subject':
        if (!runOnly) fail(`${key} is only valid for verify run`, 'Run: npx rhinoq verify run <rule-name> --subject <id>');
        options.subjectId = requiredOption(key, value); break;
      case '--cursor':
        if (!runOnly) fail(`${key} is only valid for verify run`, 'Run: npx rhinoq verify run <rule-name> --cursor <cursor>');
        options.cursor = requiredOption(key, value); break;
      default: fail(`unknown verify option ${JSON.stringify(key)}`, 'Run: npx rhinoq verify apply <rule-name> --subject-type report');
    }
  }
  return options;
}

function requiredOption(key: string, value: string | undefined): string {
  if (!value?.trim()) fail(`${key} requires a value`, `Run: npx rhinoq verify apply <rule-name> --subject-type report`);
  return value.trim();
}

function positiveInteger(key: string, value: string | undefined): number {
  const parsed = Number(requiredOption(key, value));
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${key} must be a positive integer`, 'Use a bounded positive value');
  return parsed;
}

function positiveNumber(key: string, value: string | undefined): number {
  const parsed = Number(requiredOption(key, value));
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${key} must be positive`, 'Use a bounded positive value');
  return parsed;
}

function durationMs(value: string, key: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) fail(`${key} must use a duration such as 5m, 30s or 2h`, 'Use a positive duration');
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * (units[match[2]!] ?? 0);
  if (!Number.isFinite(result) || result <= 0) fail(`${key} must be positive`, 'Use a positive duration');
  return Math.round(result);
}

async function readRule(name: string): Promise<string> {
  const path = resolve('.rhinoq', 'rules', `${name}.sql`);
  try { return await readFile(path, 'utf8'); }
  catch { fail(`Rule file not found: ${path}`, `Run: npx rhinoq verify add ${name}`); }
}

function ruleTemplate(): string {
  return `SELECT id::text AS subject_id,
       output_url IS NULL AS violated,
       jsonb_build_object('status', status, 'hasOutput', output_url IS NOT NULL) AS evidence
FROM completed_reports
WHERE created_at >= $1
  AND id::text > $2
ORDER BY id
LIMIT $3
`;
}

function validateLocalRuleQuery(query: string, tableRule = false): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) return 'query is empty';
  if (trimmed.length > 32 * 1024) return 'query exceeds 32 KiB';
  if (!/^(select|with)\s/i.test(trimmed)) return 'query must start with SELECT or WITH';
  if (/[;]|--|\/\*|\*\//.test(trimmed)) return 'comments and multiple statements are not allowed';
  if (!trimmed.includes('$1')) return 'query must contain $1';
  if (tableRule && (!trimmed.includes('$2') || !trimmed.includes('$3'))) return 'table Rule must contain $2 and $3';
  return undefined;
}

function humanizeRuleName(name: string): string {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

async function gatewayRequest(path: string, init: RequestInit, allowMissing = false): Promise<any> {
  const base = (process.env.RHINOQ_AGENT_URL ?? process.env.RHINOQ_GATEWAY_URL ?? '').replace(/\/+$/, '');
  if (!base) fail('RHINOQ_AGENT_URL/RHINOQ_GATEWAY_URL is not set', 'Start the Go Gateway with the full Rule schema, set its URL and retry');
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const token = process.env.RHINOQ_AGENT_TOKEN ?? process.env.RHINOQ_GATEWAY_TOKEN;
  if (token) headers.set('authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`${base}${path}`, { ...init, headers }); }
  catch (error) { fail(`cannot reach Go Gateway: ${safe(error)}`, 'Start the Gateway and verify RHINOQ_AGENT_URL/RHINOQ_AGENT_TOKEN'); }
  if (allowMissing && response.status === 404) {
    await response.text();
    return undefined;
  }
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.error ?? payload?.message ?? text;
    fail(`Go Gateway returned HTTP ${response.status}: ${message}`, 'Inspect the Rule schema, table/column names and Explain safety limits');
  }
  return payload;
}

// doctor checks the isolated Task profile and local Rule files. It is
// deliberately not the Go `rhinoq doctor`, which also validates worker
// identity, lease/heartbeat/reaper timing and migration state. They share a
// name because they answer the same question for different planes, so this one
// says out loud what it did not look at: a PASS here is not a runtime PASS.
async function doctor(): Promise<void> {
  const resolved = requireDatabase('doctor');
  console.log('INFO scope: Task schema, local Rule files and client packages.');
  console.log('INFO not checked here: worker identity, lease/heartbeat/reaper timing,');
  console.log('     RhinoQ migration state. Those need the Go CLI: rhinoq doctor --ci');
  console.log(`INFO PostgreSQL target ${resolved.target} from ${resolved.source}.`);
  const pool = new Pool({ ...resolved.pool, connectionTimeoutMillis: 5_000 });
  let invalidRules = false;
  try {
    await pool.query('SELECT 1');
    const result = await pool.query<{ version: number }>('SELECT COALESCE(MAX(version),0)::int AS version FROM rhinoq_task.migrations');
    const installed = result.rows[0]?.version ?? 0;
    if (installed !== TASK_SCHEMA_VERSION) fail(`Task schema is v${installed}; SDK needs v${TASK_SCHEMA_VERSION}`, 'Run: npx rhinoq init');
    console.log('PASS PostgreSQL reachable.');
    console.log(`PASS Task schema v${installed} current.`);
    invalidRules = await doctorRules(pool);
  } finally { await pool.end(); }
  if (invalidRules) fail('one or more local Rule files failed the safety contract', 'Edit the reported .rhinoq/rules/*.sql files, then rerun: npx rhinoq doctor');
  if (process.env.REDIS_URL) console.log('PASS REDIS_URL detected for BullMQ.');
  else console.log('INFO REDIS_URL is absent; this is fine unless the app uses BullMQ.');
  console.log('NEXT create the visible failure fixture: npx rhinoq fixture failure');
  console.log('NEXT before a pilot, run the runtime checks too: rhinoq doctor --ci');
}

async function doctorRules(pool: Pool): Promise<boolean> {
  const directory = resolve('.rhinoq', 'rules');
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort(); }
  catch { console.log('INFO no local .rhinoq/rules directory; Rule checks skipped.'); return false; }
  if (files.length === 0) {
    console.log('INFO no local Rule files found.');
    return false;
  }
  let invalid = false;
  for (const file of files) {
    const query = await readFile(resolve(directory, file), 'utf8');
    const problem = validateLocalRuleQuery(query, true);
    if (problem) {
      invalid = true;
      console.log(`FAIL Rule file ${file}: ${problem}`);
    } else {
      console.log(`PASS Rule file ${file} matches the bounded table Rule contract.`);
    }
  }
  const role = await pool.query<{ name: string; superuser: boolean }>(
    'SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
  );
  const currentRole = role.rows[0];
  if (currentRole?.superuser) {
    console.log(`WARN PostgreSQL role ${currentRole.name} is a superuser; use a restricted read-only Rule role before evaluating business SQL.`);
  } else if (currentRole) {
    console.log(`PASS PostgreSQL role ${currentRole.name} is not a superuser.`);
  }
  const relation = await pool.query<{ relation: string | null }>(
    `SELECT to_regclass('public.rhinoq_rules')::text AS relation`,
  );
  if (!relation.rows[0]?.relation) {
    console.log('INFO full Rule schema is not installed; local Rule files are linted but not applied.');
    return invalid;
  }
  const ids = files.map((file) => file.slice(0, -4));
  const applied = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM rhinoq_rules WHERE id = ANY($1::text[])', [ids],
  );
  const appliedIDs = new Set(applied.rows.map((row) => row.id));
  for (const id of ids) {
    if (!appliedIDs.has(id)) console.log(`WARN Rule file ${id}.sql has not been applied to rhinoq_rules.`);
    else console.log(`PASS Rule ${id} is present in rhinoq_rules.`);
  }
  return invalid;
}

// notify reads and writes the same .rhinoq/notifications.json the Go CLI uses.
// A Node team could not configure a destination at all before this: the only
// path was to build a NotificationDestination in Go and embed it, which is
// exactly the team the feature was added for.
//
// `send` is deliberately absent. A real Finding delivery goes through the
// durable delivery ledger, and reimplementing that dedup here would put
// correctness in two languages.
async function notify(args: string[]): Promise<void> {
  const action = args[0];
  switch (action) {
    case 'add': await notifyAdd(args.slice(1)); return;
    case 'list': await notifyList(args.slice(1)); return;
    case 'remove': await notifyRemove(args.slice(1)); return;
    case 'test': await notifyTest(args.slice(1)); return;
    case 'send':
      fail(
        'npx rhinoq notify send is not available in the Node SDK',
        'A real Finding delivery is recorded in the durable delivery ledger, which the Go engine owns. Run: rhinoq notify send',
      );
      return;
    default:
      fail('notify requires `add`, `list`, `remove` or `test`', 'Run: npx rhinoq notify list');
  }
}

async function notifyAdd(args: string[]): Promise<void> {
  const name = destinationName(args[0]);
  const options = parseNotifyOptions(args.slice(1));
  if (!options.url && !options.urlEnv) {
    fail(
      'a destination needs --webhook <url>, --slack <url> or --url-env <VAR>',
      `Run: npx rhinoq notify add ${name} --webhook https://example.com/hooks/rhinoq`,
    );
  }
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  const existing = registry.destinations.findIndex((entry) => entry.name === name);
  if (existing >= 0 && !options.replace) {
    fail(`destination ${JSON.stringify(name)} already exists in ${path}`, `Run: npx rhinoq notify add ${name} --replace ...`);
  }
  const entry: NotifyDestinationEntry = {
    name,
    kind: options.kind,
    ...(options.url ? { url: options.url } : {}),
    ...(options.urlEnv ? { urlEnv: options.urlEnv } : {}),
    ...(options.secretEnv ? { secretEnv: options.secretEnv } : {}),
    ...(options.timeoutMs === 10_000 ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.includeEvidence ? { includeEvidence: true } : {}),
    ...(options.gracePeriodMs ? { gracePeriodMs: options.gracePeriodMs } : {}),
    ...(options.findingBaseUrl ? { findingBaseUrl: options.findingBaseUrl } : {}),
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) registry.destinations[existing] = entry;
  else registry.destinations.push(entry);
  registry.schemaVersion = NOTIFY_REGISTRY_VERSION;
  await saveNotifyRegistry(path, registry);
  console.log(`PASS destination ${JSON.stringify(name)} ${existing >= 0 ? 'replaced in' : 'added to'} ${path}`);
  if (!entry.secretEnv) {
    console.log('WARN no --secret-env, so events are sent unsigned and the receiver cannot tell they came from RhinoQ.');
    console.log(`NEXT sign them: npx rhinoq notify add ${name} --replace --secret-env ${defaultSecretEnv(name)} ...`);
  }
  console.log(`NEXT prove it works without writing anything: npx rhinoq notify test ${name}`);
}

async function notifyList(args: string[]): Promise<void> {
  const asJSON = args.includes('--json');
  for (const raw of args) {
    if (raw !== '--json') fail(`unknown list option ${JSON.stringify(raw)}`, 'Run: npx rhinoq notify list --json');
  }
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  // A Slack incoming-webhook URL is itself the credential, so even the
  // machine-readable form is redacted.
  const redacted = registry.destinations.map((entry) => ({
    ...entry,
    ...(entry.url ? { url: redactURL(entry.url) } : {}),
  }));
  if (asJSON) {
    console.log(JSON.stringify({ schemaVersion: registry.schemaVersion, destinations: redacted }, null, 2));
    return;
  }
  for (const entry of redacted) {
    console.log(`${entry.name}\t${entry.kind}\t${entry.url ?? `$${entry.urlEnv ?? ''}`}\t${entry.secretEnv ? 'signed' : 'UNSIGNED'}`);
  }
  console.log(`\n${redacted.length} destination(s) in ${path}`);
  if (redacted.length === 0) {
    console.log('NEXT add one: npx rhinoq notify add ops --webhook https://example.com/hooks/rhinoq');
  }
}

async function notifyRemove(args: string[]): Promise<void> {
  const name = destinationName(args[0]);
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  const remaining = registry.destinations.filter((entry) => entry.name !== name);
  if (remaining.length === registry.destinations.length) {
    fail(`no destination named ${JSON.stringify(name)} in ${path}`, 'List what is configured: npx rhinoq notify list');
  }
  await saveNotifyRegistry(path, { ...registry, destinations: remaining });
  console.log(`PASS destination ${JSON.stringify(name)} removed from ${path}`);
}

async function notifyTest(args: string[]): Promise<void> {
  const name = destinationName(args[0]);
  const path = notifyRegistryPath();
  const registry = await loadNotifyRegistry(path);
  let destination;
  try {
    destination = resolveNotifyDestination(registry, name);
  } catch (error) {
    fail(safe(error), 'List what is configured: npx rhinoq notify list');
  }
  try {
    const receipt = await sendTestNotification(destination);
    console.log(`PASS destination ${JSON.stringify(name)} accepted event ${receipt.id}`);
    console.log(`     type=${receipt.type} severity=${receipt.severity} sent=${receipt.sentAt}`);
    if (destination.secret) {
      console.log('     The receiver should have verified X-RhinoQ-Signature: v1=<hmac-sha256>.');
    } else {
      console.log('     This destination is unsigned; the receiver cannot tell the event came from RhinoQ.');
    }
    console.log('     No business data was sent and nothing was recorded.');
  } catch (error) {
    console.error(`FAIL destination ${JSON.stringify(name)} did not accept the test event: ${safe(error)}`);
    console.error('     Nothing was written; no Finding or delivery record exists.');
    console.error("     Check the URL, the receiver's signature verification and its TLS.");
    process.exitCode = 1;
    throw new Error('__reported__');
  }
}

type NotifyOptions = {
  kind: NotifyKind;
  url: string;
  urlEnv: string;
  secretEnv: string;
  timeoutMs: number;
  includeEvidence: boolean;
  gracePeriodMs: number;
  findingBaseUrl: string;
  replace: boolean;
};

function parseNotifyOptions(args: string[]): NotifyOptions {
  const options: NotifyOptions = {
    kind: 'webhook', url: '', urlEnv: '', secretEnv: '', timeoutMs: 10_000,
    includeEvidence: false, gracePeriodMs: 0, findingBaseUrl: '', replace: false,
  };
  let kindWasSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === '--replace') { options.replace = true; continue; }
    if (raw === '--include-evidence') { options.includeEvidence = true; continue; }
    const [key, inline] = raw.split('=', 2);
    const value = inline ?? args[++index];
    switch (key) {
      case '--webhook': options.kind = 'webhook'; kindWasSet = true; options.url = requiredOption(key, value); break;
      case '--slack': options.kind = 'slack'; kindWasSet = true; options.url = requiredOption(key, value); break;
      case '--url': options.url = requiredOption(key, value); break;
      case '--url-env': options.urlEnv = requiredOption(key, value); break;
      case '--kind': {
        const kind = requiredOption(key, value);
        if (kind !== 'webhook' && kind !== 'slack') fail('--kind must be webhook or slack', 'Run: npx rhinoq notify add ops --kind slack --url-env RHINOQ_NOTIFY_URL_OPS');
        options.kind = kind; kindWasSet = true; break;
      }
      case '--secret-env': options.secretEnv = requiredOption(key, value); break;
      case '--timeout': options.timeoutMs = durationMs(requiredOption(key, value), key); break;
      case '--grace': options.gracePeriodMs = durationMs(requiredOption(key, value), key); break;
      case '--link-base': options.findingBaseUrl = requiredOption(key, value); break;
      default: fail(`unknown notify option ${JSON.stringify(key)}`, 'Run: npx rhinoq notify add ops --webhook <url> --secret-env <VAR>');
    }
  }
  // A --url-env destination with no --kind would default to webhook, and a
  // Slack URL posted as a signed webhook fails in a way nobody reads as
  // "wrong kind". Make the caller say which it is.
  if (options.urlEnv && !options.url && !kindWasSet) {
    fail('--url-env needs --kind webhook or --kind slack', 'Run: npx rhinoq notify add ops --kind slack --url-env RHINOQ_NOTIFY_URL_OPS');
  }
  return options;
}

function destinationName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) {
    fail('destination name must be 1-63 letters, digits, dots, dashes or underscores', 'Example: ops');
  }
  return name;
}

// A path or query can carry the credential, and for Slack it always does.
function redactURL(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : '/…'}`;
  } catch {
    return '(unparsable URL)';
  }
}

async function fixture(args: string[]): Promise<void> {
  if ((args[0] ?? 'failure') !== 'failure') fail('only the `failure` fixture exists', 'Run: npx rhinoq fixture failure');
  const pool = new Pool(requireDatabase('fixture failure').pool);
  try {
    const tasks = await installPostgresTaskProfile(pool);
    const id = `demo_${Date.now()}`;
    let task = await tasks.createTask({ id, type: 'report.generate', ownerId: 'demo-user', definitionVersion: 1 });
    task = await tasks.transitionTask(id, task.entityVersion, 'queued');
    task = await tasks.transitionTask(id, task.entityVersion, 'running');
    await tasks.createTaskExecution(id, { id: `${id}:1`, runtime: 'bullmq', runtimeScope: 'reports', externalId: `${id}:job` });
    let execution = await tasks.getTaskExecution(`${id}:1`);
    await tasks.bindTaskExecution(execution.id, { runtime: 'bullmq', runtimeScope: 'reports', externalId: `${id}:job` });
    execution = await tasks.getTaskExecution(execution.id);
    await tasks.transitionTaskExecution(execution.id, execution.version, 'running');
    execution = await tasks.getTaskExecution(execution.id);
    await tasks.transitionTaskExecution(execution.id, execution.version, 'succeeded');
    task = await tasks.getTask(id);
    task = await tasks.transitionTask(id, task.entityVersion, 'uncertain');
    console.log(`PASS created ${task.id}: BullMQ execution=succeeded, real-world Task=uncertain.`);
    console.log('NEXT inspect it: npx rhinoq dev');
  } finally { await pool.end(); }
}

async function dev(args: string[]): Promise<void> {
  const portValue = Number(args.find((item) => item.startsWith('--port='))?.slice(7) ?? 8788);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) fail('port must be 1..65535', 'Example: npx rhinoq dev --port=8788');
  const pool = new Pool(requireDatabase('dev').pool);
  const server = createServer(async (_request, response) => {
    try {
      const result = await pool.query(`SELECT id,type,state,version,updated_at FROM rhinoq_task.tasks ORDER BY updated_at DESC LIMIT 25`);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page(result.rows));
    } catch (error) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`RhinoQ cannot read PostgreSQL. NEXT run: npx rhinoq doctor\n${safe(error)}`);
    }
  });
  server.listen(portValue, '127.0.0.1', () => console.log(`PASS RhinoQ dev view: http://127.0.0.1:${portValue}\nNEXT press Ctrl+C to stop.`));
  const close = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.once('SIGINT', close); process.once('SIGTERM', close);
}

function page(rows: unknown[]): string {
  const body = rows.map((value) => { const row = value as Record<string, unknown>; return `<tr><td>${escapeHTML(row.id)}</td><td>${escapeHTML(row.type)}</td><td><strong>${escapeHTML(row.state)}</strong></td><td>${escapeHTML(row.version)}</td></tr>`; }).join('');
  return `<!doctype html><meta charset="utf-8"><title>RhinoQ dev</title><style>body{font:16px system-ui;max-width:960px;margin:4rem auto;padding:0 1rem;background:#0b1020;color:#eef}table{width:100%;border-collapse:collapse}td,th{padding:.8rem;border-bottom:1px solid #334}strong{color:#ffcc66}code{color:#9fe}</style><h1>RhinoQ dev</h1><p>Technical completion is not the same as a real-world outcome.</p><p><strong>Next step:</strong> write a Rule for a real business table, apply it through the Go Gateway, then run a bounded verification: <code>npx rhinoq verify apply &lt;name&gt; --subject-type &lt;type&gt;</code> → <code>npx rhinoq verify run &lt;name&gt;</code>.</p><table><thead><tr><th>Task</th><th>Type</th><th>Real-world state</th><th>Version</th></tr></thead><tbody>${body}</tbody></table>`;
}

async function detectPackages(): Promise<{ pg: boolean; bullmq: boolean }> {
  try { const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string> }; const all={...pkg.dependencies,...pkg.devDependencies}; return {pg:Boolean(all.pg),bullmq:Boolean(all.bullmq)}; }
  catch { return {pg:false,bullmq:false}; }
}
async function writeNew(path: string, content: string): Promise<void> { try { await access(path); console.log(`KEEP ${path} already exists.`); } catch { await writeFile(path, content, { flag:'wx' }); } }
function escapeHTML(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
function safe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nextAction(error: unknown): string { const message=safe(error); if (/connect|ECONN|database/i.test(message)) return 'Start PostgreSQL and verify the connection variables, then run: npx rhinoq doctor'; return 'Run: npx rhinoq help'; }
function fail(message: string, next: string): never { console.error(`FAIL ${message}\nNEXT ${next}`); process.exitCode=1; throw new Error('__reported__'); }
function help(): void { console.log(`RhinoQ developer CLI\n\n  npx rhinoq init\n  npx rhinoq verify add completed-report-has-output\n  npx rhinoq verify apply completed-report-has-output --subject-type report\n  npx rhinoq verify run completed-report-has-output\n  npx rhinoq verify delete completed-report-has-output [--apply]\n  npx rhinoq doctor\n  npx rhinoq notify add ops --webhook https://example.com/hooks/rhinoq --secret-env RHINOQ_NOTIFY_SECRET_OPS\n  npx rhinoq notify list [--json]\n  npx rhinoq notify test ops\n  npx rhinoq notify remove ops\n  npx rhinoq fixture failure\n  npx rhinoq dev\n\nverify apply on an existing Rule prints what changed and needs --force, because\na new version does not reopen Findings recorded against the old one.\nverify delete previews by default; --apply performs it.\n\nPostgreSQL connection, in order: RHINOQ_DATABASE_URL, DATABASE_URL, then the\ndiscrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE variables\n(RHINOQ_DB_HOST/_PORT/_USER/_PASSWORD/_NAME/_SSLMODE win over those). Discrete\nconfiguration needs at least a host and a database name.\n\nnotify reads and writes the same .rhinoq/notifications.json as the Go CLI, and\nnever stores a secret: an entry names an environment variable. "notify test"\nsends one synthetic signed event and writes nothing - no Finding, no delivery\nrecord. "notify send" is Go-only: a real delivery goes through the durable\ndelivery ledger the engine owns.\n\nThis CLI checks the isolated Task profile only. For runtime checks - fencing,\nlease/heartbeat timing, the reaper and migration state - build and run the Go\nCLI: rhinoq doctor.\n\nEvery failure includes the next action.`); }
