// Package rule defines the canonical integrity rule contract. A rule reports
// violations; the application layer folds them into persistent findings.
package rule

import (
	"errors"
	"regexp"
	"strings"
	"time"
)

type Scope string

const (
	JobScope   Scope = "job"
	TableScope Scope = "table"
)

func (s Scope) Valid() bool { return s == JobScope || s == TableScope }

type Status string

const (
	Draft    Status = "draft"
	Enabled  Status = "enabled"
	Disabled Status = "disabled"
)

func (s Status) Valid() bool {
	return s == Draft || s == Enabled || s == Disabled
}

const (
	MaxIDBytes            = 128
	MaxNameBytes          = 200
	MaxSubjectTypeBytes   = 64
	MaxJobNameBytes       = 128
	MaxQueryBytes         = 32 << 10
	DefaultMaxRows        = 500
	MaximumMaxRows        = 1000
	DefaultStatementLimit = 5 * time.Second
	MaximumStatementLimit = 30 * time.Second
	DefaultMaxPlanCost    = 100_000
	DefaultMaxSeqScanRows = 10_000
)

var (
	ErrInvalidRule       = errors.New("invalid integrity rule")
	ErrUnsafeQuery       = errors.New("rule query is not a single read-only SELECT")
	ErrBaselineRequired  = errors.New("table-scoped rule requires an explicit baseline")
	ErrIntervalRequired  = errors.New("table-scoped rule requires a positive interval")
	ErrRuleUnsafe        = errors.New("rule explain exceeded its query safety budget")
	ErrScheduleLeaseLost = errors.New("rule schedule lease was lost")
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
var queryStartPattern = regexp.MustCompile(`(?is)^(select|with)\s`)

// Record is one versioned Rule. Query returns candidate observations with
// three canonical columns, plus an optional fourth:
//
//	subject_id      text
//	violated        boolean, nullable: true violated, false passed, NULL unknown
//	evidence        json/jsonb or text
//	unknown_reason  text, optional; only read when violated IS NULL
//
// violated is nullable because SQL already has the three-valued logic this
// needs. A query that cannot decide - the provider timed out, the object could
// not be read, the confirmation deadline has not passed - returns NULL instead
// of guessing, and RhinoQ applies the Rule's UnknownPolicy.
//
// Job scope receives $1 = business subject ID.
// Table scope receives $1 = baseline timestamp, $2 = the last subject cursor,
// and $3 = max rows. RhinoQ also wraps the query with a hard LIMIT.
type Record struct {
	ID          string
	Version     int
	Name        string
	Scope       Scope
	Status      Status
	SubjectType string
	JobName     string
	Query       string
	BaselineAt  time.Time
	Every       time.Duration
	Within      time.Duration
	MaxRows     int
	// OnUnknown decides what an inconclusive observation does. Defaults to
	// UnknownRetries.
	OnUnknown UnknownPolicy

	StatementTimeout time.Duration
	MaxPlanCost      float64
	MaxSeqScanRows   int64

	CreatedAt time.Time
	UpdatedAt time.Time
}

func (r Record) WithDefaults() Record {
	if r.OnUnknown == "" {
		r.OnUnknown = UnknownRetries
	}
	if r.Status == "" {
		r.Status = Draft
	}
	if r.MaxRows == 0 {
		r.MaxRows = DefaultMaxRows
	}
	if r.StatementTimeout == 0 {
		r.StatementTimeout = DefaultStatementLimit
	}
	if r.MaxPlanCost == 0 {
		r.MaxPlanCost = DefaultMaxPlanCost
	}
	if r.MaxSeqScanRows == 0 {
		r.MaxSeqScanRows = DefaultMaxSeqScanRows
	}
	return r
}

func (r Record) Validate() error {
	if r.ID == "" || len(r.ID) > MaxIDBytes || !idPattern.MatchString(r.ID) ||
		r.Version < 1 || strings.TrimSpace(r.Name) == "" ||
		len(r.Name) > MaxNameBytes || !r.Scope.Valid() || !r.Status.Valid() ||
		strings.TrimSpace(r.SubjectType) == "" ||
		len(r.SubjectType) > MaxSubjectTypeBytes {
		return ErrInvalidRule
	}
	if r.JobName != "" && len(r.JobName) > MaxJobNameBytes {
		return ErrInvalidRule
	}
	if r.Scope == JobScope && strings.TrimSpace(r.JobName) == "" {
		return ErrInvalidRule
	}
	if r.Scope == TableScope {
		if r.BaselineAt.IsZero() {
			return ErrBaselineRequired
		}
		if r.Every <= 0 {
			return ErrIntervalRequired
		}
		if !strings.Contains(r.Query, "$2") || !strings.Contains(r.Query, "$3") {
			return ErrUnsafeQuery
		}
	}
	if r.Within < 0 || r.MaxRows <= 0 || r.MaxRows > MaximumMaxRows ||
		r.StatementTimeout <= 0 || r.StatementTimeout > MaximumStatementLimit ||
		r.MaxPlanCost <= 0 || r.MaxSeqScanRows <= 0 || !r.OnUnknown.Valid() {
		return ErrInvalidRule
	}
	return ValidateQuery(r.Query)
}

// ValidateQuery is deliberately a syntax guard, not a SQL security boundary.
// PostgreSQL read-only transactions and a restricted database role are the
// actual boundary. This guard rejects obvious multi-statement/comment tricks
// and enforces the one canonical parameter.
func ValidateQuery(query string) error {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" || len(trimmed) > MaxQueryBytes ||
		!queryStartPattern.MatchString(trimmed) ||
		strings.Contains(trimmed, ";") ||
		strings.Contains(trimmed, "--") ||
		strings.Contains(trimmed, "/*") ||
		strings.Contains(trimmed, "*/") ||
		!strings.Contains(trimmed, "$1") {
		return ErrUnsafeQuery
	}
	return nil
}

type Query struct {
	Scope    Scope
	Statuses []Status
	Offset   int
	Limit    int
}

func (q Query) Validate() error {
	if q.Scope != "" && !q.Scope.Valid() {
		return ErrInvalidRule
	}
	if q.Offset < 0 || q.Limit <= 0 || q.Limit > 1000 {
		return ErrInvalidRule
	}
	for _, status := range q.Statuses {
		if !status.Valid() {
			return ErrInvalidRule
		}
	}
	return nil
}

type SeqScan struct {
	Relation      string
	EstimatedRows int64
}

type Explanation struct {
	Safe          bool
	PlanCost      float64
	EstimatedRows int64
	SeqScans      []SeqScan
	Reasons       []string
	ExplainedAt   time.Time
	QueryHash     string
}

// ObservationStatus is what one check concluded about one subject.
//
// A boolean cannot express this. A provider that timed out, a bucket RhinoQ
// may not read, evidence that has not arrived yet and a confirmation whose
// deadline has not passed are all cases where the answer is genuinely unknown.
// Forced into a boolean, false reads as "this subject is fine" - which silently
// hides drift - and true invents a violation that may not exist.
type ObservationStatus string

const (
	Passed   ObservationStatus = "passed"
	Violated ObservationStatus = "violated"
	Unknown  ObservationStatus = "unknown"
)

func (s ObservationStatus) Valid() bool {
	return s == Passed || s == Violated || s == Unknown
}

// UnknownPolicy decides what an inconclusive observation does. It belongs to
// the Rule because the right answer depends on the invariant: a missing S3
// object may mean "ask again in a minute", while a permission RhinoQ never
// regains means a human has to look.
type UnknownPolicy string

const (
	// UnknownRetries records the observation and opens nothing. The next
	// evaluation asks again. This is the default because most unknowns are
	// transient, and an alert per transient failure trains operators to ignore
	// alerts.
	UnknownRetries UnknownPolicy = "retry"
	// UnknownOpensFinding treats an inconclusive check as drift needing a
	// person. Use it when not knowing is itself the problem.
	UnknownOpensFinding UnknownPolicy = "finding"
)

func (p UnknownPolicy) Valid() bool {
	return p == UnknownRetries || p == UnknownOpensFinding
}

// MaxUnknownReasonBytes bounds the reason code a query may return.
const MaxUnknownReasonBytes = 128

// UnknownUnspecified is recorded when a query reports unknown without saying
// why. It is deliberately not an error: losing the observation would be worse
// than recording an unlabelled one.
const UnknownUnspecified = "unspecified"

type Observation struct {
	SubjectID string
	Status    ObservationStatus
	Evidence  string
	// Reason names why a check could not conclude. It is meaningful only when
	// Status is Unknown, and is what makes an unknown actionable rather than
	// just absent: provider_timeout, permission_denied, evidence_missing,
	// awaiting_confirmation.
	Reason string
}

func (o Observation) Validate() error {
	if strings.TrimSpace(o.SubjectID) == "" || len(o.SubjectID) > 256 ||
		len(o.Evidence) > 64<<10 {
		return ErrInvalidRule
	}
	if !o.Status.Valid() {
		return ErrInvalidRule
	}
	if len(o.Reason) > MaxUnknownReasonBytes {
		return ErrInvalidRule
	}
	if o.Status != Unknown && o.Reason != "" {
		// A reason on a conclusive observation means the query is reporting
		// something the model cannot carry, which is worth failing loudly.
		return ErrInvalidRule
	}
	return nil
}

type Evaluation struct {
	Observations []Observation
	NextCursor   string
	HasMore      bool
	EvaluatedAt  time.Time
}

// ScheduleLease fences one scheduler execution. Cursor is the last completely
// evaluated subject, so a replacement process can resume without skipping a
// page after a crash.
type ScheduleLease struct {
	RuleID    string
	Version   int
	Owner     string
	Epoch     int64
	Cursor    string
	Every     time.Duration
	ClaimedAt time.Time
	ExpiresAt time.Time
}

func (l ScheduleLease) Validate() error {
	if l.RuleID == "" || l.Version < 1 || strings.TrimSpace(l.Owner) == "" ||
		l.Epoch < 1 || l.Every <= 0 || l.ClaimedAt.IsZero() ||
		l.ExpiresAt.IsZero() {
		return ErrInvalidRule
	}
	return nil
}
