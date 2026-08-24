import { access, readdir, readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

/** A deliberately read-only finding from the Integration Eraser preview. */
export interface RhinoQIntegrationEraserFinding {
  category:
    | 'status-route'
    | 'polling-hook'
    | 'bullmq-listener'
    | 'upload-proxy'
    | 'retry-timer'
    | 'job-handler'
    | 'job-producer'
    | 'external-effect'
    | 'cancellation-boundary';
  confidence: 'high' | 'review';
  file: string;
  line: number;
  evidence: string;
  replacement: string;
  consumerOwned: true;
  reviewReason?: string;
}

export interface RhinoQIntegrationEraserPreviewChange {
  file: string;
  line: number;
  action: 'manual-review';
  replacement: string;
  confidence: RhinoQIntegrationEraserFinding['confidence'];
  patch: string;
}

export interface RhinoQIntegrationEraserReport {
  schemaVersion: 2;
  mode: 'preview-only';
  root: string;
  filesScanned: number;
  linesScanned: number;
  skippedLargeFiles: number;
  skippedIgnoredFiles: number;
  truncated: boolean;
  detected: string[];
  findings: RhinoQIntegrationEraserFinding[];
  replaceableEstimate: {
    files: number;
    matchingLines: number;
    methodology: 'high-confidence static match lines; not a deletion or savings claim';
  };
  stillApplicationOwned: ['auth', 'handler', 'business verification'];
  preview: {
    changes: RhinoQIntegrationEraserPreviewChange[];
    diff: string;
    rollback: {
      kind: 'none' | 'patch-preview';
      reason: string;
      patch?: string;
    };
  };
  warnings: string[];
}

export interface RhinoQIntegrationEraserOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxFindings?: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.cjs', '.go', '.java', '.js', '.jsx', '.mjs', '.py', '.rb', '.rs', '.ts', '.tsx',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.rhinoq', '.turbo', '.vite', '.cache', '.parcel-cache',
  '.svelte-kit', '.vercel', '__tests__', 'bench', 'build', 'codegen', 'coverage',
  'dist', 'fixtures', 'generated', 'mocks', 'node_modules', 'out', 'storybook-static',
  'target', 'test', 'tests', 'tmp', 'vendor',
]);

const IGNORED_FILE_SUFFIXES = new Set(['.d.ts', '.map', '.snap', '.lock']);

const DETECTION_RULES: ReadonlyArray<{
  category: RhinoQIntegrationEraserFinding['category'];
  label: string;
  replacement: string;
  high: (context: string) => boolean;
  review: (context: string) => boolean;
  reviewReason: string;
}> = [
  {
    category: 'status-route',
    label: 'status routes',
    replacement: 'RhinoQ owner Task API and Task Center',
    high: (context) =>
      /\b(?:get|post|put|patch|delete|all)\s*\(\s*[`'\"][^`'\"]*(?:\/status\b|\/progress\b|\/tasks?\b|\/jobs?\b)/i.test(context) &&
      /\b(?:json|send|end|response|res)\b/i.test(context),
    review: (context) => /\/(?:status|progress|tasks?|jobs?)(?:\/|['"`])/i.test(context),
    reviewReason: 'route-like status path found without enough context to prove an owner Task endpoint',
  },
  {
    category: 'polling-hook',
    label: 'polling hooks',
    replacement: 'RhinoQ polling/SSE/WebSocket client with stale-version handling',
    high: (context) =>
      /\b(?:setInterval|setTimeout)\s*\(/i.test(context) &&
      /\b(?:fetch|axios|poll(?:ing)?|status|progress|task)\b/i.test(context),
    review: (context) =>
      /\b(?:setInterval|setTimeout)\s*\(/i.test(context) && /\b(?:job|queue|watch)\b/i.test(context),
    reviewReason: 'timer and job-related code found, but a network polling loop was not proven statically',
  },
  {
    category: 'bullmq-listener',
    label: 'BullMQ lifecycle listeners',
    replacement: 'RhinoQ BullMQ Task projection and bounded reconciliation bridge',
    high: (context) =>
      /\bQueueEvents\b/i.test(context) ||
      /\.(?:on|once)\s*\(\s*[`'\"](?:completed|failed|progress|active|stalled)[`'\"]/i.test(context),
    review: (context) => /\b(?:bullmq|queueevents|queue event|completed|failed|progress)\b/i.test(context),
    reviewReason: 'queue lifecycle vocabulary found without a clear listener or QueueEvents declaration',
  },
  {
    category: 'upload-proxy',
    label: 'upload proxies',
    replacement: 'RhinoQ direct-upload and private artifact path',
    high: (context) =>
      /\b(?:multipart|multer|putObject|createReadStream|req\.on\s*\(\s*[`'\"]data|proxy)\b/i.test(context) &&
      /\b(?:req|request|body|file|stream|upload)\b/i.test(context),
    review: (context) => /\b(?:upload|multipart|multer|putObject|proxy)\b/i.test(context),
    reviewReason: 'upload-related code found, but the request-to-provider proxy boundary needs human review',
  },
  {
    category: 'retry-timer',
    label: 'retry timers',
    replacement: 'RhinoQ runtime retry, delay and lease policy',
    high: (context) =>
      /\b(?:setInterval|setTimeout)\s*\(/i.test(context) &&
      /\b(?:retry|requeue|backoff|attempt)\b/i.test(context),
    review: (context) =>
      /\b(?:setInterval|setTimeout)\s*\(/i.test(context) && /\b(?:delay|again)\b/i.test(context),
    reviewReason: 'timer may implement retry behavior, but its failure and lease semantics need human review',
  },
  {
    category: 'job-handler',
    label: 'job handlers',
    replacement: 'RhinoQ typed Task declaration around the existing business handler',
    high: (context) => /\b(?:Worker|Processor|process)\s*\(|@Processor\s*\(|@Process\s*\(/i.test(context),
    review: (context) => /\b(?:handler|processor|consumer|worker)\b/i.test(context) && /\b(?:job|queue|task)\b/i.test(context),
    reviewReason: 'worker vocabulary found, but a callable job handler was not proven statically',
  },
  {
    category: 'job-producer',
    label: 'job producers',
    replacement: 'RhinoQ typed Task dispatcher with stable business and owner identity',
    high: (context) => /\.(?:add|send|publish|enqueue)\s*\(/i.test(context) && /\b(?:queue|job|task|message)\b/i.test(context),
    review: (context) => /\b(?:enqueue|producer|publish|dispatch)\b/i.test(context),
    reviewReason: 'dispatch vocabulary found, but a queue producer and stable identity were not proven statically',
  },
  {
    category: 'external-effect',
    label: 'external effects',
    replacement: 'RhinoQ context.effect() with application-approved idempotency and confirmation policy',
    high: (context) => /\b(?:stripe|s3|mailer|email|twilio|sendgrid|fetch|axios|putObject|sendEmail|refund|charge)\b/i.test(context) && /\b(?:await|send|create|post|put|delete|request)\b/i.test(context),
    review: (context) => /\b(?:provider|webhook|payment|storage|email|http)\b/i.test(context),
    reviewReason: 'provider vocabulary found; a retryable external mutation and its idempotency policy need human review',
  },
  {
    category: 'cancellation-boundary',
    label: 'cancellation boundaries',
    replacement: 'RhinoQ cancellation capability with explicit safe/unsupported/uncertain behavior',
    high: (context) => /\b(?:AbortController|AbortSignal|cancelRequested|requestCancellation|job\.discard|job\.remove)\b/i.test(context),
    review: (context) => /\b(?:cancel|abort|terminate|kill)\b/i.test(context),
    reviewReason: 'cancellation vocabulary found, but terminal safety and external-effect behavior need human review',
  },
];

/**
 * Scan source files for common adopter-owned async integration glue.
 *
 * This function intentionally does not parse, import, execute or modify the
 * repository. It is a bounded evidence collector, not a codemod.
 */
export async function scanRhinoQIntegrationEraser(
  rootDirectory: string,
  options: RhinoQIntegrationEraserOptions = {},
): Promise<RhinoQIntegrationEraserReport> {
  const root = resolve(rootDirectory);
  const maxFiles = options.maxFiles ?? 2_000;
  const maxBytesPerFile = options.maxBytesPerFile ?? 512 * 1024;
  const maxFindings = options.maxFindings ?? 200;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer');
  if (!Number.isSafeInteger(maxBytesPerFile) || maxBytesPerFile < 1) throw new Error('maxBytesPerFile must be a positive integer');
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1) throw new Error('maxFindings must be a positive integer');

  const candidates = await collectSourceFiles(root, maxFiles);
  const findings: RhinoQIntegrationEraserFinding[] = [];
  let filesScanned = 0;
  let linesScanned = 0;
  let skippedLargeFiles = 0;
  let skippedIgnoredFiles = candidates.ignoredFiles;

  for (const file of candidates.files) {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      continue;
    }
    if (size > maxBytesPerFile) {
      skippedLargeFiles += 1;
      continue;
    }
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (isGeneratedSource(source)) {
      skippedIgnoredFiles += 1;
      continue;
    }
    const lines = source.split(/\r?\n/);
    filesScanned += 1;
    linesScanned += lines.length;
    for (const rule of DETECTION_RULES) {
      const match = findRuleMatch(lines, rule.high, rule.review);
      if (!match) continue;
      if (findings.length >= maxFindings) break;
      findings.push({
        category: rule.category,
        confidence: match.confidence,
        file: toReportPath(root, file),
        line: match.line + 1,
        evidence: redactEvidence(lines[match.line] ?? ''),
        replacement: rule.replacement,
        consumerOwned: true,
        ...(match.confidence === 'review' ? { reviewReason: rule.reviewReason } : {}),
      });
    }
    if (findings.length >= maxFindings) break;
  }

  const highConfidence = findings.filter((finding) => finding.confidence === 'high');
  const matchingLines = new Set(highConfidence.map((finding) => `${finding.file}:${finding.line}`));
  const detected = DETECTION_RULES
    .filter((rule) => findings.some((finding) => finding.category === rule.category))
    .map((rule) => rule.label);
  const warnings: string[] = [];
  if (candidates.truncated) warnings.push(`file scan stopped at the ${maxFiles}-file bound`);
  if (skippedLargeFiles) warnings.push(`${skippedLargeFiles} source file(s) exceeded the ${maxBytesPerFile}-byte bound`);
  if (skippedIgnoredFiles) warnings.push(`${skippedIgnoredFiles} generated/ignored source file(s) were excluded; use a focused root or review your .rhinoqignore`);
  if (findings.length >= maxFindings) warnings.push(`finding output stopped at the ${maxFindings}-finding bound`);
  if (!findings.length) warnings.push('no supported integration pattern was detected; absence is not proof that glue is absent');

  const changes = findings.map((finding) => previewChange(finding));
  const diff = changes.map((change) => change.patch).join('\n');
  const rollbackPatch = changes
    .map((change) => reversePatch(change.patch))
    .join('\n');

  return {
    schemaVersion: 2,
    mode: 'preview-only',
    root,
    filesScanned,
    linesScanned,
    skippedLargeFiles,
    skippedIgnoredFiles,
    truncated: candidates.truncated,
    detected,
    findings,
    replaceableEstimate: {
      files: new Set(highConfidence.map((finding) => finding.file)).size,
      matchingLines: matchingLines.size,
      methodology: 'high-confidence static match lines; not a deletion or savings claim',
    },
    stillApplicationOwned: ['auth', 'handler', 'business verification'],
    preview: {
      changes,
      diff,
      rollback: {
        kind: changes.length ? 'patch-preview' : 'none',
        reason: changes.length
          ? 'manual-review reverse patch preview; no files were written, patched or deleted'
          : 'preview-only scanner; no files were written, patched or deleted',
        ...(rollbackPatch ? { patch: rollbackPatch } : {}),
      },
    },
    warnings,
  };
}

function previewChange(finding: RhinoQIntegrationEraserFinding): RhinoQIntegrationEraserPreviewChange {
  const oldLine = finding.evidence || '<matched integration glue>';
  const newLine = `// manual-review only: replace with ${finding.replacement}`;
  return {
    file: finding.file,
    line: finding.line,
    action: 'manual-review',
    replacement: finding.replacement,
    confidence: finding.confidence,
    patch: `--- a/${finding.file}\n+++ b/${finding.file}\n@@ -${finding.line},1 +${finding.line},1 @@\n-${oldLine}\n+${newLine}`,
  };
}

function reversePatch(patch: string): string {
  return patch.replace(/@@ -(\d+),1 \+\1,1 @@\n-([^\n]*)\n\+([^\n]*)/, '@@ -$1,1 +$1,1 @@\n-$3\n+$2');
}

function findRuleMatch(
  lines: string[],
  high: (context: string) => boolean,
  review: (context: string) => boolean,
): { line: number; confidence: 'high' | 'review' } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
    if (high(context)) return { line: index, confidence: 'high' };
  }
  for (let index = 0; index < lines.length; index += 1) {
    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
    if (review(context)) return { line: index, confidence: 'review' };
  }
  return undefined;
}

async function collectSourceFiles(root: string, maxFiles: number): Promise<{ files: string[]; truncated: boolean; ignoredFiles: number }> {
  const files: string[] = [];
  const pending = [root];
  const ignorePatterns = await readIgnorePatterns(root);
  let ignoredFiles = 0;
  let truncated = false;
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || matchesIgnore(path, root, ignorePatterns)) {
          ignoredFiles += 1;
          continue;
        }
        try {
          await access(resolve(path, '.git'));
          ignoredFiles += 1;
          continue;
        } catch { /* not a nested repository */ }
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (isIgnoredFileName(entry.name) || matchesIgnore(path, root, ignorePatterns)) {
        ignoredFiles += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated, ignoredFiles };
      }
      files.push(path);
    }
  }
  return { files, truncated, ignoredFiles };
}

async function readIgnorePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of ['.gitignore', '.rhinoqignore']) {
    try {
      const source = await readFile(resolve(root, name), 'utf8');
      patterns.push(...source.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !line.startsWith('!')));
    } catch { /* ignore files are optional */ }
  }
  return patterns;
}

function matchesIgnore(path: string, root: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const relativePath = relative(root, path).split('\\').join('/');
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
    if (!normalized) return false;
    if (normalized.includes('*')) {
      const expression = new RegExp(`^${normalized.split('*').map(escapeRegExp).join('.*')}(?:/|$)`);
      return expression.test(relativePath);
    }
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  });
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isGeneratedSource(source: string): boolean {
  return /(^|\n)\s*(?:\/\/|#|\/\*)\s*(?:@generated|generated by|code generated|do not edit)/i.test(source.slice(0, 1_000));
}

function isIgnoredFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.d.ts') || IGNORED_FILE_SUFFIXES.has(extname(lower));
}

function toReportPath(root: string, file: string): string {
  return relative(root, file).split('\\').join('/');
}

function redactEvidence(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ').slice(0, 180);
  return compact.replace(/((?:token|secret|password|api[-_]?key)\s*[:=]\s*)(["'`])[^"'`]*\2/gi, '$1$2<redacted>$2');
}
