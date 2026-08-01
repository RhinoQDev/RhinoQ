// Package workbench serves RhinoQ's local, read-only developer interface.
//
// The package owns HTTP and presentation contracts only. It cannot reach a
// database itself: a composition root must provide a Reader backed by the
// public RhinoQ application facade.
package workbench

import (
	"context"
	"encoding/json"
	"time"
)

const (
	DefaultLimit = 100
	MaxLimit     = 250
)

type Query struct {
	Queue  string
	States []string
	Limit  int
}

type Reader interface {
	Snapshot(context.Context, Query) (Snapshot, error)
	JobDetail(context.Context, string) (JobDetail, error)
	SubjectDetail(context.Context, SubjectRef) (SubjectDetail, error)
}

// Operator exposes only application use cases that are safe to call from the
// loopback Workbench. Implementations must never execute arbitrary SQL.
type Operator interface {
	Recheck(context.Context, SubjectRef, string) (ActionResult, error)
	ProposeRepair(context.Context, RepairProposal) (RepairPlan, error)
	PreviewRepair(context.Context, string) (RepairPlan, error)
	ApproveRepair(context.Context, string, string, string) (RepairPlan, error)
	ExecuteRepair(context.Context, string) (RepairPlan, error)
}

type ActionResult struct {
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type RepairProposal struct {
	Finding    FindingRef      `json:"finding"`
	Handler    string          `json:"handler"`
	Parameters json.RawMessage `json:"parameters"`
	Actor      string          `json:"actor"`
}

type FindingRef struct {
	RuleID           string `json:"ruleId"`
	SubjectType      string `json:"subjectType"`
	SubjectID        string `json:"subjectId"`
	InvariantVersion int    `json:"invariantVersion"`
}

type RepairPlan struct {
	ID             string `json:"id"`
	State          string `json:"state"`
	Handler        string `json:"handler"`
	Preview        string `json:"preview,omitempty"`
	Precondition   string `json:"precondition,omitempty"`
	ProposedBy     string `json:"proposedBy"`
	ApprovedBy     string `json:"approvedBy,omitempty"`
	ApprovalReason string `json:"approvalReason,omitempty"`
	Outcome        string `json:"outcome,omitempty"`
	DryRun         bool   `json:"dryRun"`
	Version        int64  `json:"version"`
}

// SubjectRef names the business thing an investigation is about.
type SubjectRef struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// ExecutionRef names a run that touched a subject, in whatever system performed
// it. A RhinoQ job appears here as source system "rhinoq".
type ExecutionRef struct {
	SourceSystem string    `json:"sourceSystem"`
	SourceID     string    `json:"sourceId"`
	JobID        string    `json:"jobId,omitempty"`
	FirstSeen    time.Time `json:"firstSeen"`
	LastSeen     time.Time `json:"lastSeen"`
	Effects      int       `json:"effects"`
}

// SubjectSummary is the answer an investigator wants before reading anything
// else: is this subject in drift right now, and since when.
type SubjectSummary struct {
	// State is "clean", "drift" or "unknown". Unknown is its own state because
	// folding it into clean is how an unreachable provider hides real drift.
	State string `json:"state"`
	// Headline says the same thing in one sentence.
	Headline       string `json:"headline"`
	OpenFindings   int    `json:"openFindings"`
	Findings       int    `json:"findings"`
	PendingEffects int    `json:"pendingEffects"`
	// UncertainEffects are effects whose execution died before confirming.
	UncertainEffects int       `json:"uncertainEffects"`
	FirstSeen        time.Time `json:"firstSeen,omitempty"`
	LastSeen         time.Time `json:"lastSeen,omitempty"`
}

// SubjectEventKind separates what RhinoQ observed from what a person decided,
// because an investigator reading a timeline needs to tell them apart.
const (
	SubjectEventObservation = "observation"
	SubjectEventDecision    = "decision"
	SubjectEventEffect      = "effect"
)

// SubjectEvent is one entry in the subject timeline. Observations, operator
// decisions and effects are merged into one ordered list, because that is the
// order the investigator lived through.
type SubjectEvent struct {
	Kind       string    `json:"kind"`
	OccurredAt time.Time `json:"occurredAt"`
	// Label is the short human phrase: "violation observed", "acknowledged",
	// "upload-report confirmed".
	Label string `json:"label"`
	// RuleID and InvariantVersion are set for observations and decisions, so a
	// reader can tell which version of the invariant produced them.
	RuleID           string `json:"ruleId,omitempty"`
	InvariantVersion int    `json:"invariantVersion,omitempty"`
	FromStatus       string `json:"fromStatus,omitempty"`
	ToStatus         string `json:"toStatus,omitempty"`
	Actor            string `json:"actor,omitempty"`
	Reason           string `json:"reason,omitempty"`
	Evidence         string `json:"evidence,omitempty"`
	// Execution is set for effects, naming who performed the run.
	Execution string `json:"execution,omitempty"`
}

// SubjectDetail is the investigation view for one business subject.
//
// It exists because the Workbench had the right tables and no way to connect
// them: jobs, findings, rules and evidence sat next to each other, and an
// operator asking "what happened to report_3912" had to join them by eye. This
// is the page where the layers meet from the user's side rather than the
// engine's.
type SubjectDetail struct {
	Subject SubjectRef     `json:"subject"`
	Summary SubjectSummary `json:"summary"`
	// Findings are the persistent drift records for this subject, newest first.
	Findings []Finding `json:"findings"`
	// History merges observations, operator decisions and effects in time order.
	History []SubjectEvent `json:"history"`
	Effects []Effect       `json:"effects"`
	// Executions lists every run that touched this subject, RhinoQ or not.
	Executions []ExecutionRef `json:"executions"`
	Notices    []string       `json:"notices,omitempty"`
}

type Source struct {
	Mode     string `json:"mode"`
	Label    string `json:"label"`
	ReadOnly bool   `json:"readOnly"`
}

type Snapshot struct {
	Product     string           `json:"product"`
	Version     string           `json:"version"`
	GeneratedAt time.Time        `json:"generatedAt"`
	Source      Source           `json:"source"`
	Counts      map[string]int64 `json:"counts"`
	Jobs        []Job            `json:"jobs"`
	Attention   []AttentionItem  `json:"attention"`
	Findings    []Finding        `json:"findings"`
	Rules       []Rule           `json:"rules"`
	Queues      []string         `json:"queues"`
	Limits      map[string]int   `json:"limits"`
	Notices     []string         `json:"notices,omitempty"`
}

type Job struct {
	ID              string    `json:"id"`
	QueueName       string    `json:"queueName"`
	JobName         string    `json:"jobName"`
	GroupKey        string    `json:"groupKey,omitempty"`
	State           string    `json:"state"`
	ResourceClass   string    `json:"resourceClass"`
	Stage           string    `json:"stage"`
	Priority        int       `json:"priority"`
	Attempts        int       `json:"attempts"`
	CrashCount      int       `json:"crashCount"`
	BlockedReason   string    `json:"blockedReason,omitempty"`
	CorrelationID   string    `json:"correlationId,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	NotBefore       time.Time `json:"notBefore"`
	CancelRequested bool      `json:"cancelRequested"`
}

type AttentionItem struct {
	Kind        string    `json:"kind"`
	JobID       string    `json:"jobId,omitempty"`
	Queue       string    `json:"queue,omitempty"`
	JobState    string    `json:"jobState,omitempty"`
	ReferenceID string    `json:"referenceId,omitempty"`
	Reason      string    `json:"reason"`
	ObservedAt  time.Time `json:"observedAt"`
}

type Finding struct {
	RuleID           string    `json:"ruleId"`
	SubjectType      string    `json:"subjectType"`
	SubjectID        string    `json:"subjectId"`
	InvariantVersion int       `json:"invariantVersion"`
	Status           string    `json:"status"`
	FirstSeen        time.Time `json:"firstSeen"`
	LastSeen         time.Time `json:"lastSeen"`
	OccurrenceCount  int       `json:"occurrenceCount"`
	LatestEvidence   string    `json:"latestEvidence,omitempty"`
}

type Rule struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Scope       string        `json:"scope"`
	SubjectType string        `json:"subjectType"`
	JobName     string        `json:"jobName,omitempty"`
	Version     int           `json:"version"`
	Status      string        `json:"status"`
	Every       time.Duration `json:"every"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

type JobDetail struct {
	Job      Job       `json:"job"`
	Attempts []Attempt `json:"attempts"`
	Effects  []Effect  `json:"effects"`
	Outcomes []Outcome `json:"outcomes"`
	Audit    []Audit   `json:"audit"`
	Notices  []string  `json:"notices,omitempty"`
}

type Attempt struct {
	Sequence      int64     `json:"sequence"`
	Attempt       int       `json:"attempt"`
	LeaseOwner    string    `json:"leaseOwner"`
	LeaseEpoch    int64     `json:"leaseEpoch"`
	Kind          string    `json:"kind"`
	ResultState   string    `json:"resultState,omitempty"`
	FailureClass  string    `json:"failureClass,omitempty"`
	BlockedReason string    `json:"blockedReason,omitempty"`
	OccurredAt    time.Time `json:"occurredAt"`
}

type Effect struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// SourceSystem and SourceID name the execution that opened this effect.
	// JobID is set only when RhinoQ ran it, which is also the only case where
	// LeaseEpoch means anything.
	SourceSystem   string    `json:"sourceSystem,omitempty"`
	SourceID       string    `json:"sourceId,omitempty"`
	JobID          string    `json:"jobId,omitempty"`
	IdempotencyKey string    `json:"idempotencyKey"`
	State          string    `json:"state"`
	Irreversible   bool      `json:"irreversible"`
	ExternalRef    string    `json:"externalRef,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	LeaseEpoch     int64     `json:"leaseEpoch"`
}

type Outcome struct {
	ID              string    `json:"id"`
	ContractVersion int       `json:"contractVersion"`
	State           string    `json:"state"`
	Reason          string    `json:"reason,omitempty"`
	ObservedVersion int64     `json:"observedVersion"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type Audit struct {
	ID         string    `json:"id"`
	Action     string    `json:"action"`
	Actor      string    `json:"actor"`
	Reason     string    `json:"reason"`
	OccurredAt time.Time `json:"occurredAt"`
	RowHash    string    `json:"rowHash"`
}
