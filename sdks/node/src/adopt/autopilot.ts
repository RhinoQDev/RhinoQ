import { createHash } from 'node:crypto';

import type {
  RhinoQIntegrationEraserFinding,
  RhinoQIntegrationEraserReport,
} from './eraser.js';
import type { ShadowAdoptionReport } from '../runtime/integration.js';

export type RhinoQAdoptionDecision = 'ready' | 'needs-confirmation' | 'blocked';

export interface RhinoQAdoptionDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  decision: RhinoQAdoptionDecision;
  subject: { file: string; line: number; category: RhinoQIntegrationEraserFinding['category'] };
  whatHappened: string;
  whyItMatters: string;
  whatRhinoQDid: string;
  howToFix: string;
  verify: string;
  approvalKey?: string;
}

export interface RhinoQAdoptionPlan {
  schemaVersion: 1;
  kind: 'rhinoq-native-adoption-plan';
  fingerprint: string;
  root: string;
  status: RhinoQAdoptionDecision;
  scan: {
    filesScanned: number;
    linesScanned: number;
    truncated: boolean;
  };
  inventory: {
    handlers: number;
    producers: number;
    externalEffects: number;
    cancellationBoundaries: number;
    replaceableGlue: number;
  };
  diagnostics: readonly RhinoQAdoptionDiagnostic[];
  requiredApprovals: readonly string[];
  shadow: {
    required: true;
    reason: string;
    command: string;
  };
  stillApplicationOwned: readonly ['auth', 'handler', 'business verification', 'effect policy'];
}

export interface RhinoQAdoptionPromotionEvidence {
  planFingerprint: string;
  approvals: readonly string[];
  shadow: {
    durable: boolean;
    unresolvedEvents: number;
    capabilityGaps: readonly string[];
    observedEvents: number;
  };
}

export interface RhinoQAdoptionPromotion {
  schemaVersion: 1;
  kind: 'rhinoq-adoption-promotion';
  planFingerprint: string;
  status: 'ready' | 'blocked';
  blockers: readonly string[];
  approved: readonly string[];
  command?: string;
  note: 'promotion is an approval artifact; runtime ownership changes only through the existing explicit adoption integration';
}

/** Converts the real runtime report into the exact fail-closed promotion input. */
export function compileRhinoQAdoptionPromotionEvidence(
  plan: RhinoQAdoptionPlan,
  report: ShadowAdoptionReport,
  approvals: readonly string[] = [],
): RhinoQAdoptionPromotionEvidence {
  if (!plan || plan.kind !== 'rhinoq-native-adoption-plan') throw new TypeError('a RhinoQ adoption plan is required');
  if (!report || report.schemaVersion !== 1 || report.mode !== 'observe') throw new TypeError('a RhinoQ Shadow Adoption report is required');
  const durable = report.checklist?.some((item) => item.id === 'durable_reporting' && item.status === 'configured') === true;
  return Object.freeze({
    planFingerprint: plan.fingerprint,
    approvals: Object.freeze([...new Set(approvals)].sort()),
    shadow: Object.freeze({
      durable,
      unresolvedEvents: report.unresolvedEvents,
      capabilityGaps: Object.freeze([...new Set(report.guaranteeGaps ?? [])].sort()),
      observedEvents: report.observedEvents,
    }),
  });
}

/**
 * Turns a bounded read-only repository scan into a deterministic adoption and
 * safety plan. It never imports application source or guesses owner identity,
 * business correctness, idempotency keys or provider confirmation policy.
 */
export function compileRhinoQAdoptionPlan(report: RhinoQIntegrationEraserReport): RhinoQAdoptionPlan {
  if (!report || report.mode !== 'preview-only' || !Array.isArray(report.findings)) {
    throw new TypeError('RhinoQ adoption planning requires a preview-only Integration Eraser report');
  }
  const diagnostics = report.findings.map(adoptionDiagnostic);
  if (!report.findings.some((item) => item.category === 'job-handler')) diagnostics.push({
    code: 'RHINOQ_ADOPT_HANDLER_IDENTITY_REQUIRED', severity: 'warning', decision: 'needs-confirmation',
    subject: { file: '(repository)', line: 1, category: 'job-handler' }, approvalKey: 'approve:application-handler-inventory',
    whatHappened: 'The bounded scan did not prove a background job handler.',
    whyItMatters: 'Absence of a static match is not proof that no handler exists; generated integration could target the wrong composition root.',
    whatRhinoQDid: 'Left handler selection to the application and generated no runtime mutation.',
    howToFix: 'Declare each intended queue-to-Task handler explicitly.',
    verify: 'Run npx rhinoq adopt --plan from the application root and review ignored/generated paths.',
  });
  if (report.truncated) diagnostics.push({
    code: 'RHINOQ_ADOPT_SCAN_TRUNCATED', severity: 'error', decision: 'blocked',
    subject: { file: '(repository)', line: 1, category: 'job-handler' },
    whatHappened: 'The repository scan reached its configured bound before inventory completed.',
    whyItMatters: 'Promotion from partial evidence can miss handlers, effects or cancellation boundaries.',
    whatRhinoQDid: 'Blocked promotion and left the repository unchanged.',
    howToFix: 'Use a focused application root or increase the bounded scan limit programmatically.',
    verify: 'Regenerate a plan whose scan.truncated value is false.',
  });
  diagnostics.sort(compareDiagnostic);
  const requiredApprovals = [...new Set(diagnostics.flatMap((item) => item.approvalKey ? [item.approvalKey] : []))].sort();
  const status: RhinoQAdoptionDecision = diagnostics.some((item) => item.decision === 'blocked')
    ? 'blocked'
    : requiredApprovals.length
      ? 'needs-confirmation'
      : 'ready';
  const canonical = {
    root: report.root,
    findings: report.findings.map((item) => ({
      category: item.category, confidence: item.confidence, file: item.file, line: item.line,
    })).sort((left, right) => `${left.file}:${left.line}:${left.category}`.localeCompare(`${right.file}:${right.line}:${right.category}`)),
    requiredApprovals,
  };
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'rhinoq-native-adoption-plan' as const,
    fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    root: report.root,
    status,
    scan: Object.freeze({ filesScanned: report.filesScanned, linesScanned: report.linesScanned, truncated: report.truncated }),
    inventory: Object.freeze({
      handlers: count(report, 'job-handler'),
      producers: count(report, 'job-producer'),
      externalEffects: count(report, 'external-effect'),
      cancellationBoundaries: count(report, 'cancellation-boundary'),
      replaceableGlue: report.replaceableEstimate.matchingLines,
    }),
    diagnostics: Object.freeze(diagnostics),
    requiredApprovals: Object.freeze(requiredApprovals),
    shadow: Object.freeze({
      required: true as const,
      reason: 'Observe real runtime identity and lifecycle evidence before transferring dispatch or cancellation ownership.',
      command: 'npx rhinoq adopt --shadow --adapter <adapter> --apply',
    }),
    stillApplicationOwned: Object.freeze(['auth', 'handler', 'business verification', 'effect policy'] as const),
  });
}

/** Produces a fail-closed promotion artifact; it performs no runtime mutation. */
export function evaluateRhinoQAdoptionPromotion(
  plan: RhinoQAdoptionPlan,
  evidence: RhinoQAdoptionPromotionEvidence,
): RhinoQAdoptionPromotion {
  if (!plan || plan.kind !== 'rhinoq-native-adoption-plan' || plan.schemaVersion !== 1) throw new TypeError('a RhinoQ adoption plan is required');
  if (evidence?.planFingerprint !== plan.fingerprint) throw new Error('promotion evidence does not match the adoption plan fingerprint');
  const approved = [...new Set(evidence.approvals ?? [])].sort();
  const blockers: string[] = [];
  if (plan.status === 'blocked') blockers.push('the adoption plan itself is blocked; resolve compiler diagnostics and regenerate it');
  for (const approval of plan.requiredApprovals) if (!approved.includes(approval)) blockers.push(`missing approval ${approval}`);
  if (!evidence.shadow?.durable) blockers.push('shadow evidence is not durable across replicas');
  if ((evidence.shadow?.observedEvents ?? 0) < 1) blockers.push('shadow mode has not observed a runtime event');
  if ((evidence.shadow?.unresolvedEvents ?? 0) > 0) blockers.push(`${evidence.shadow.unresolvedEvents} shadow event(s) lack proven application identity`);
  for (const gap of evidence.shadow?.capabilityGaps ?? []) blockers.push(`capability gap: ${gap}`);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'rhinoq-adoption-promotion' as const,
    planFingerprint: plan.fingerprint,
    status: blockers.length ? 'blocked' as const : 'ready' as const,
    blockers: Object.freeze(blockers),
    approved: Object.freeze(approved),
    ...(blockers.length ? {} : { command: 'npx rhinoq adopt --mode <reviewed-single-or-fanout> --apply' }),
    note: 'promotion is an approval artifact; runtime ownership changes only through the existing explicit adoption integration' as const,
  });
}

function adoptionDiagnostic(finding: RhinoQIntegrationEraserFinding): RhinoQAdoptionDiagnostic {
  const subject = { file: finding.file, line: finding.line, category: finding.category };
  const approvalKey = `approve:${finding.category}:${finding.file}:${finding.line}`;
  if (finding.category === 'external-effect') return {
    code: 'RHINOQ_ADOPT_EXTERNAL_EFFECT_POLICY_REQUIRED', severity: 'error', decision: 'needs-confirmation', subject, approvalKey,
    whatHappened: 'A possible external provider mutation exists inside retryable background work.',
    whyItMatters: 'A lost response can leave an unknown real-world result; a blind retry may duplicate the effect.',
    whatRhinoQDid: 'Kept the candidate out of automatic promotion and generated no idempotency or confirmation policy.',
    howToFix: 'Approve an application-owned idempotency key and context.effect() confirmation/readback policy.',
    verify: `Review ${finding.file}:${finding.line}, then rerun npx rhinoq adopt --plan.`,
  };
  if (finding.category === 'cancellation-boundary') return {
    code: 'RHINOQ_ADOPT_CANCELLATION_POLICY_REQUIRED', severity: 'warning', decision: 'needs-confirmation', subject, approvalKey,
    whatHappened: 'Application cancellation code was detected without proof of its terminal semantics.',
    whyItMatters: 'Shutdown, user cancellation and an uncertain provider result must not be collapsed into one terminal outcome.',
    whatRhinoQDid: 'Left cancellation ownership unchanged.',
    howToFix: 'Declare cancellation as safe, unsupported or uncertain and preserve the Effect Ledger boundary.',
    verify: `Review ${finding.file}:${finding.line}, then exercise the cancellation fault fixture.`,
  };
  if (finding.category === 'retry-timer') return {
    code: 'RHINOQ_ADOPT_RETRY_POLICY_REQUIRED', severity: 'warning', decision: 'needs-confirmation', subject, approvalKey,
    whatHappened: 'An application-owned retry timer or backoff loop was detected.',
    whyItMatters: 'Moving retry ownership without classifying failures can replay unsafe work or create two retry coordinators.',
    whatRhinoQDid: 'Proposed manual review and did not remove or rewrite the timer.',
    howToFix: 'Map retryable, terminal and uncertain failures to the authoritative runtime policy.',
    verify: `Review ${finding.file}:${finding.line} and run the real retry fault test.`,
  };
  const review = finding.confidence === 'review';
  return {
    code: review ? 'RHINOQ_ADOPT_STATIC_REVIEW_REQUIRED' : 'RHINOQ_ADOPT_REPLACEMENT_CANDIDATE',
    severity: review ? 'warning' : 'info', decision: review ? 'needs-confirmation' : 'ready', subject,
    ...(review ? { approvalKey } : {}),
    whatHappened: `${finding.category} integration code was detected by a bounded static scan.`,
    whyItMatters: 'This code may be replaceable by RhinoQ, but static evidence cannot prove application intent.',
    whatRhinoQDid: 'Produced a preview-only candidate and did not modify the repository.',
    howToFix: finding.replacement,
    verify: `Review ${finding.file}:${finding.line} and compare the generated adoption diff.`,
  };
}

function count(report: RhinoQIntegrationEraserReport, category: RhinoQIntegrationEraserFinding['category']): number {
  return report.findings.filter((item) => item.category === category).length;
}

function compareDiagnostic(left: RhinoQAdoptionDiagnostic, right: RhinoQAdoptionDiagnostic): number {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return rank[left.severity] - rank[right.severity] || `${left.subject.file}:${left.subject.line}:${left.code}`.localeCompare(`${right.subject.file}:${right.subject.line}:${right.code}`);
}
