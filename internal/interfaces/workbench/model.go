// Package workbench serves RhinoQ's local, read-only developer interface.
//
// The package owns HTTP and presentation contracts only. It cannot reach a
// database itself: a composition root must provide a Reader backed by the
// public RhinoQ application facade.
package workbench

import (
	"context"
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
	ID             string    `json:"id"`
	Name           string    `json:"name"`
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
