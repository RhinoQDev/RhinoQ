package postgres

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/admission"
	"github.com/madebyduy/RhinoQ/internal/domain/attempt"
	"github.com/madebyduy/RhinoQ/internal/domain/job"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var (
	ErrLeaseLost = ports.ErrLeaseLost
	ErrNotFound  = ports.ErrJobNotFound
)

// jobColumns is the projection every read uses. Keeping it in one place stops
// the scan order from drifting between queries.
const jobColumns = `j.id, j.queue_name, j.job_name, COALESCE(j.group_key, ''),
	j.payload, j.state, j.resource_class, j.priority, j.attempts,
	j.crash_count, COALESCE(j.blocked_reason, ''), COALESCE(j.idempotency_key, ''),
	COALESCE(j.correlation_id, ''), j.created_at, j.not_before,
	COALESCE(j.lease_owner, ''), j.lease_epoch,
	COALESCE(j.lease_until, 'epoch'::timestamptz), j.cancel_requested`

// effectivePrioritySQL mirrors job.EffectivePriority: priority first, aged
// upwards by waiting time and capped, so nothing starves. Change both together.
const effectivePrioritySQL = `(j.priority + LEAST(EXTRACT(epoch FROM (now() - j.not_before)) / 3600.0, 5.0))`

// effectivePriorityBare is the same expression over unqualified columns, for use
// against a CTE that already projected them. now() is stable within a statement,
// and the lease update touches neither priority nor not_before, so re-applying
// the expression after the update reproduces the original claim order exactly.
const effectivePriorityBare = `(priority + LEAST(EXTRACT(epoch FROM (now() - not_before)) / 3600.0, 5.0))`

// claimReturningColumns and claimSelectColumns are the same projection twice:
// once qualified for RETURNING, once bare for reading it back out of the CTE.
// Both must stay in scanJob's order.
const claimReturningColumns = `j.id, j.queue_name, j.job_name,
	COALESCE(j.group_key, '') AS group_key, j.payload, j.state, j.resource_class,
	j.priority, j.attempts, j.crash_count,
	COALESCE(j.blocked_reason, '') AS blocked_reason,
	COALESCE(j.idempotency_key, '') AS idempotency_key,
	COALESCE(j.correlation_id, '') AS correlation_id,
	j.created_at, j.not_before, COALESCE(j.lease_owner, '') AS lease_owner,
	j.lease_epoch, COALESCE(j.lease_until, 'epoch'::timestamptz) AS lease_until,
	j.cancel_requested`

const claimSelectColumns = `id, queue_name, job_name, group_key, payload, state,
	resource_class, priority, attempts, crash_count, blocked_reason,
	idempotency_key, correlation_id, created_at, not_before, lease_owner,
	lease_epoch, lease_until, cancel_requested`

// maxClaimCandidates caps how far a single claim may look ahead when it
// over-fetches to survive rate-limited queues. It protects the database from a
// worker asking for an unbounded batch.
const maxClaimCandidates = 1000

var _ ports.JobStore = (*JobStore)(nil)

type JobStore struct {
	db *sql.DB
}

func NewJobStore(db *sql.DB) (*JobStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &JobStore{db: db}, nil
}

func (s *JobStore) Enqueue(ctx context.Context, input ports.EnqueueInput) (ports.JobID, error) {
	identity, err := input.Identity.Normalize()
	if err != nil {
		return "", err
	}
	if err := job.ValidatePayload(input.Payload, job.DefaultMaxPayloadBytes); err != nil {
		return "", err
	}
	if input.Priority < job.MinPriority || input.Priority > job.MaxPriority {
		return "", job.ErrInvalidPriority
	}
	if input.RunAfter < 0 {
		return "", errors.New("run-after delay must not be negative")
	}
	id, err := newID("job")
	if err != nil {
		return "", err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	// Admission is a property of the execution lane, not of the handler
	// contract, so it is keyed on the queue name.
	deferBy, err := s.admitTx(ctx, tx, identity.QueueName, identity.ResourceClass.IsCritical())
	if err != nil {
		return "", err
	}

	var idempotency any
	if input.IdempotencyKey != "" {
		idempotency = input.IdempotencyKey
	}
	// The database clock is the authority for scheduling (specification 50.3):
	// not_before is derived in SQL, never from a worker's wall clock.
	var storedID string
	err = tx.QueryRowContext(ctx, `
		INSERT INTO rhinoq_jobs
			(id, queue_name, job_name, group_key, payload, state, resource_class,
			 priority, idempotency_key, correlation_id, not_before)
		VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9,
			now() + (($10::bigint + $11::bigint) * interval '1 millisecond'))
		ON CONFLICT (queue_name, idempotency_key)
		DO UPDATE SET job_name = EXCLUDED.job_name
		RETURNING id`,
		id, identity.QueueName, identity.JobName, nullableString(identity.GroupKey),
		input.Payload, string(identity.ResourceClass), input.Priority,
		idempotency, nullableString(input.CorrelationID),
		input.RunAfter.Milliseconds(), deferBy.Milliseconds(),
	).Scan(&storedID)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return ports.JobID(storedID), nil
}

// admitTx applies producer backpressure. The pending count is bounded by the
// capacity itself, so even a full queue costs a partial-index scan of at most
// capacity rows instead of counting the whole backlog.
func (s *JobStore) admitTx(ctx context.Context, tx *sql.Tx, queueName string, critical bool) (time.Duration, error) {
	var maxPending, reserved, delayMS, retryAfterMS sql.NullInt64
	var mode sql.NullString
	err := tx.QueryRowContext(ctx, `
		SELECT admission_max_pending, admission_reserved_critical, admission_overflow_mode,
		       admission_delay_ms, admission_retry_after_ms
		FROM rhinoq_queue_controls WHERE queue_name = $1
		FOR UPDATE`, queueName).
		Scan(&maxPending, &reserved, &mode, &delayMS, &retryAfterMS)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !maxPending.Valid {
		return 0, nil
	}
	policy := admission.Policy{
		MaxPending:       int(maxPending.Int64),
		ReservedCritical: int(reserved.Int64),
		OnOverflow:       admission.Mode(mode.String),
		DelayBy:          time.Duration(delayMS.Int64) * time.Millisecond,
		RetryAfter:       time.Duration(retryAfterMS.Int64) * time.Millisecond,
	}.Normalize()

	var pending int
	if err := tx.QueryRowContext(ctx, `
		SELECT count(*) FROM (
			SELECT 1 FROM rhinoq_jobs
			WHERE queue_name = $1 AND state IN ('pending', 'retry_wait')
			LIMIT $2
		) capped`, queueName, policy.Capacity(critical)).Scan(&pending); err != nil {
		return 0, err
	}
	decision, err := policy.Decide(queueName, pending, critical)
	if err != nil {
		return 0, err
	}
	return decision.DeferBy, nil
}

func (s *JobStore) Get(ctx context.Context, id ports.JobID) (job.Record, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM rhinoq_jobs j WHERE j.id = $1`, string(id))
	record, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return job.Record{}, false, nil
	}
	return record, err == nil, err
}

func (s *JobStore) ListJobs(ctx context.Context, input ports.ListJobsInput) ([]job.Record, error) {
	if input.Offset < 0 || input.Limit <= 0 || input.Limit > 1000 {
		return nil, errors.New("offset must be non-negative and limit must be between 1 and 1000")
	}
	args := []any{input.QueueName, input.JobName, input.GroupKey}
	var query strings.Builder
	query.WriteString(`SELECT ` + jobColumns + ` FROM rhinoq_jobs j
		WHERE ($1 = '' OR j.queue_name = $1)
		  AND ($2 = '' OR j.job_name = $2)
		  AND ($3 = '' OR j.group_key = $3)`)
	if len(input.States) > 0 {
		query.WriteString(" AND j.state IN (")
		for index, state := range input.States {
			if !state.Valid() {
				return nil, errors.New("invalid job state filter")
			}
			if index > 0 {
				query.WriteString(", ")
			}
			args = append(args, state.String())
			fmt.Fprintf(&query, "$%d", len(args))
		}
		query.WriteString(")")
	}
	args = append(args, input.Limit, input.Offset)
	fmt.Fprintf(&query, " ORDER BY j.created_at DESC, j.id DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args))

	rows, err := s.db.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]job.Record, 0, input.Limit)
	for rows.Next() {
		record, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *JobStore) ListAttemptEvents(ctx context.Context, id ports.JobID, offset, limit int) ([]attempt.Event, error) {
	if id == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM rhinoq_jobs WHERE id = $1)`, string(id)).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ports.ErrJobNotFound
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT sequence, job_id, attempt_number, lease_owner, lease_epoch, kind,
		       COALESCE(result_state, ''), COALESCE(failure_class, ''),
		       COALESCE(blocked_reason, ''), occurred_at
		FROM rhinoq_attempt_events
		WHERE job_id = $1
		ORDER BY sequence
		LIMIT $2 OFFSET $3`, string(id), limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]attempt.Event, 0, limit)
	for rows.Next() {
		event, err := scanAttemptEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *JobStore) JobCounts(ctx context.Context, queueName string) (map[job.State]int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT state, count(*)
		FROM rhinoq_jobs
		WHERE ($1 = '' OR queue_name = $1)
		GROUP BY state`, queueName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := make(map[job.State]int64)
	for rows.Next() {
		var state string
		var count int64
		if err := rows.Scan(&state, &count); err != nil {
			return nil, err
		}
		counts[job.State(state)] = count
	}
	return counts, rows.Err()
}

// QueueHealth returns the counts and oldest eligible backlog timestamps in one
// aggregate read. The watchdog uses this instead of sampling a paginated job
// list, so a large queue cannot turn an alert into an unbounded scan.
func (s *JobStore) QueueHealth(ctx context.Context, queueName string) (ports.QueueHealth, error) {
	var health ports.QueueHealth
	health.QueueName = queueName
	var oldestPending, oldestRetry sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT
			count(*) FILTER (WHERE state = 'pending'),
			count(*) FILTER (WHERE state = 'retry_wait'),
			count(*) FILTER (WHERE state = 'leased'),
			min(created_at) FILTER (WHERE state = 'pending'),
			min(created_at) FILTER (WHERE state = 'retry_wait')
		FROM rhinoq_jobs
		WHERE ($1 = '' OR queue_name = $1)`, queueName).
		Scan(&health.Pending, &health.RetryWait, &health.Leased, &oldestPending, &oldestRetry)
	if err != nil {
		return ports.QueueHealth{}, err
	}
	if oldestPending.Valid {
		health.OldestPendingAt = oldestPending.Time
	}
	if oldestRetry.Valid {
		health.OldestRetryAt = oldestRetry.Time
	}
	return health, nil
}

// Claim takes a batch in exactly one round trip, whatever the batch size and
// however many execution lanes it spans.
//
// The previous implementation cost three statements plus one per distinct lane,
// and the per-lane rate reservations ran inside the window where the candidate
// rows were already locked FOR UPDATE. A worker subscribed to thirty lanes paid
// thirty extra round trips while holding those locks, so latency to other
// workers grew with the number of lanes rather than with the amount of work.
//
// Everything now happens in one statement:
//
//	locked    lock eligible candidates, over-fetching so a saturated lane
//	          cannot starve the others
//	controls  lock the rate-limit rows for those lanes, in name order
//	budget    compute each lane's remaining allowance
//	ranked    rank candidates within their lane
//	chosen    keep what fits the allowance, then the batch limit
//	reserve   consume exactly the slots that were chosen
//	leased    take the leases
//	evidence  append the claim timeline
//
// Reserving from chosen rather than from the candidate count is a deliberate
// change: the old code reserved slots for candidates it then discarded to the
// batch limit, burning rate budget on work it never claimed.
func (s *JobStore) Claim(ctx context.Context, input ports.ClaimInput) ([]job.Record, error) {
	if input.Owner == "" || input.Limit <= 0 || input.LeaseDuration <= 0 {
		return nil, errors.New("claim requires an owner, a positive limit and a lease duration")
	}
	if err := ports.ValidateClaimLimit(input.Limit); err != nil {
		return nil, err
	}
	if err := ports.ValidateClaimQueues(input.QueueNames); err != nil {
		return nil, err
	}

	query, args := s.buildClaimStatement(input)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	claimed := make([]job.Record, 0, input.Limit)
	for rows.Next() {
		record, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		claimed = append(claimed, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return claimed, nil
}

func (s *JobStore) buildClaimStatement(input ports.ClaimInput) (string, []any) {
	candidateLimit := input.Limit * 4
	if candidateLimit > maxClaimCandidates {
		candidateLimit = maxClaimCandidates
	}
	if candidateLimit < input.Limit {
		candidateLimit = input.Limit
	}

	// $1 owner, $2 lease milliseconds, $3 candidate limit, $4 batch limit.
	args := []any{input.Owner, input.LeaseDuration.Milliseconds(), candidateLimit, input.Limit}

	var laneFilter strings.Builder
	if len(input.QueueNames) > 0 {
		laneFilter.WriteString("\n\t\t\t  AND j.queue_name IN (")
		for index, name := range input.QueueNames {
			if index > 0 {
				laneFilter.WriteString(", ")
			}
			args = append(args, name)
			fmt.Fprintf(&laneFilter, "$%d", len(args))
		}
		laneFilter.WriteByte(')')
	}

	query := `
		WITH locked AS (
			SELECT j.id, j.queue_name, j.priority, j.created_at, j.not_before
			FROM rhinoq_jobs j
			LEFT JOIN rhinoq_queue_controls qc ON qc.queue_name = j.queue_name
			WHERE j.state IN ('pending', 'retry_wait')
			  AND j.not_before <= now()
			  AND qc.paused_at IS NULL` + laneFilter.String() + `
			  AND (
			      qc.rate_limit_max IS NULL
			      OR qc.rate_window_started_at IS NULL
			      OR qc.rate_window_started_at + (qc.rate_limit_window_ms * interval '1 millisecond') <= now()
			      OR qc.rate_window_count < qc.rate_limit_max
			  )
			ORDER BY ` + effectivePrioritySQL + ` DESC, j.created_at, j.id
			FOR UPDATE OF j SKIP LOCKED
			LIMIT $3
		),
		-- Lock the rate rows before reading their counters, otherwise two
		-- concurrent claims both see the same remaining allowance and both
		-- grant it. Ordering by name keeps the lock order consistent between
		-- workers so they cannot deadlock against each other.
		controls AS (
			SELECT qc.queue_name, qc.rate_limit_max, qc.rate_limit_window_ms,
			       qc.rate_window_started_at, qc.rate_window_count
			FROM rhinoq_queue_controls qc
			WHERE qc.rate_limit_max IS NOT NULL
			  AND qc.queue_name IN (SELECT queue_name FROM locked)
			ORDER BY qc.queue_name
			FOR UPDATE
		),
		budget AS (
			SELECT lanes.queue_name,
			       c.queue_name IS NOT NULL AS limited,
			       (
			           c.rate_window_started_at IS NULL
			           OR c.rate_window_started_at + (c.rate_limit_window_ms * interval '1 millisecond') <= now()
			       ) AS window_expired,
			       CASE
			           WHEN c.queue_name IS NULL THEN NULL
			           WHEN c.rate_window_started_at IS NULL
			             OR c.rate_window_started_at + (c.rate_limit_window_ms * interval '1 millisecond') <= now()
			             THEN c.rate_limit_max
			           ELSE GREATEST(c.rate_limit_max - c.rate_window_count, 0)
			       END AS allowance
			FROM (SELECT DISTINCT queue_name FROM locked) lanes
			LEFT JOIN controls c ON c.queue_name = lanes.queue_name
		),
		ranked AS (
			SELECT id, queue_name, priority, created_at, not_before,
			       row_number() OVER (
			           PARTITION BY queue_name
			           ORDER BY ` + effectivePriorityBare + ` DESC, created_at, id
			       ) AS lane_rank
			FROM locked
		),
		chosen AS (
			SELECT r.id, r.queue_name
			FROM ranked r
			JOIN budget b ON b.queue_name = r.queue_name
			WHERE b.allowance IS NULL OR r.lane_rank <= b.allowance
			ORDER BY ` + effectivePriorityBare + ` DESC, r.created_at, r.id
			LIMIT $4
		),
		taken AS (
			SELECT queue_name, count(*)::int AS slots FROM chosen GROUP BY queue_name
		),
		reserve AS (
			UPDATE rhinoq_queue_controls qc
			SET rate_window_started_at =
			        CASE WHEN b.window_expired THEN now() ELSE qc.rate_window_started_at END,
			    rate_window_count =
			        CASE WHEN b.window_expired THEN t.slots ELSE qc.rate_window_count + t.slots END,
			    updated_at = now()
			FROM taken t
			JOIN budget b ON b.queue_name = t.queue_name
			WHERE qc.queue_name = t.queue_name AND b.limited
			RETURNING qc.queue_name
		),
		leased AS (
			UPDATE rhinoq_jobs j
			SET state = 'leased',
			    attempts = j.attempts + 1,
			    blocked_reason = NULL,
			    lease_owner = $1,
			    lease_epoch = j.lease_epoch + 1,
			    lease_until = now() + ($2 * interval '1 millisecond')
			FROM chosen c
			WHERE j.id = c.id
			RETURNING ` + claimReturningColumns + `
		),
		evidence AS (
			INSERT INTO rhinoq_attempt_events
				(job_id, attempt_number, lease_owner, lease_epoch, kind, result_state)
			SELECT id, attempts, lease_owner, lease_epoch, 'claimed', 'leased'
			FROM leased
			RETURNING job_id
		)
		SELECT ` + claimSelectColumns + `
		FROM leased
		-- UPDATE ... RETURNING has no ordering guarantee. The lease touches
		-- neither priority nor not_before and now() is stable within the
		-- statement, so re-applying the ranking expression here reproduces the
		-- order the candidates were chosen in.
		ORDER BY ` + effectivePriorityBare + ` DESC, created_at, id`

	return query, args
}

func (s *JobStore) PauseQueue(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_queue_controls (queue_name, paused_at)
		VALUES ($1, now())
		ON CONFLICT (tenant_id, queue_name) DO UPDATE SET paused_at = now()`, name)
	return err
}

func (s *JobStore) ResumeQueue(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `UPDATE rhinoq_queue_controls SET paused_at = NULL WHERE queue_name = $1`, name)
	return err
}

func (s *JobStore) SetQueueRateLimit(ctx context.Context, name string, limit ports.QueueRateLimit) error {
	if name == "" || limit.Max <= 0 || limit.Window < time.Millisecond {
		return errors.New("queue name, positive max and a window of at least one millisecond are required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_queue_controls
			(queue_name, rate_limit_max, rate_limit_window_ms, rate_window_started_at, rate_window_count)
		VALUES ($1, $2, $3, NULL, 0)
		ON CONFLICT (tenant_id, queue_name) DO UPDATE
		SET rate_limit_max = EXCLUDED.rate_limit_max,
		    rate_limit_window_ms = EXCLUDED.rate_limit_window_ms,
		    rate_window_started_at = NULL,
		    rate_window_count = 0,
		    updated_at = now()`,
		name, limit.Max, limit.Window.Milliseconds())
	return err
}

func (s *JobStore) RemoveQueueRateLimit(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_queue_controls
		SET rate_limit_max = NULL,
		    rate_limit_window_ms = NULL,
		    rate_window_started_at = NULL,
		    rate_window_count = 0,
		    updated_at = now()
		WHERE queue_name = $1`, name)
	return err
}

func (s *JobStore) QueueRateLimitTTL(ctx context.Context, name string, now time.Time) (time.Duration, error) {
	if name == "" || now.IsZero() {
		return 0, errors.New("queue name and current time are required")
	}
	// The remaining window is measured against database time and returned as a
	// duration, so a worker can sleep exactly that long without trusting its own
	// clock to agree with the database.
	var remainingMS sql.NullFloat64
	err := s.db.QueryRowContext(ctx, `
		SELECT CASE
			WHEN rate_limit_max IS NULL OR rate_window_started_at IS NULL
			  OR rate_window_count < rate_limit_max THEN NULL
			ELSE GREATEST(EXTRACT(epoch FROM (
				rate_window_started_at + (rate_limit_window_ms * interval '1 millisecond') - now()
			)) * 1000, 0)
		END
		FROM rhinoq_queue_controls WHERE queue_name = $1`, name).Scan(&remainingMS)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !remainingMS.Valid) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return time.Duration(remainingMS.Float64) * time.Millisecond, nil
}

func (s *JobStore) SetQueueAdmission(ctx context.Context, name string, policy admission.Policy) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	normalized := policy.Normalize()
	if err := normalized.Validate(); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_queue_controls
			(queue_name, admission_max_pending, admission_reserved_critical,
			 admission_overflow_mode, admission_delay_ms, admission_retry_after_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (tenant_id, queue_name) DO UPDATE
		SET admission_max_pending = EXCLUDED.admission_max_pending,
		    admission_reserved_critical = EXCLUDED.admission_reserved_critical,
		    admission_overflow_mode = EXCLUDED.admission_overflow_mode,
		    admission_delay_ms = EXCLUDED.admission_delay_ms,
		    admission_retry_after_ms = EXCLUDED.admission_retry_after_ms,
		    updated_at = now()`,
		name, normalized.MaxPending, normalized.ReservedCritical, string(normalized.OnOverflow),
		normalized.DelayBy.Milliseconds(), normalized.RetryAfter.Milliseconds())
	return err
}

func (s *JobStore) RemoveQueueAdmission(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_queue_controls
		SET admission_max_pending = NULL,
		    admission_reserved_critical = NULL,
		    admission_overflow_mode = NULL,
		    admission_delay_ms = NULL,
		    admission_retry_after_ms = NULL,
		    updated_at = now()
		WHERE queue_name = $1`, name)
	return err
}

func (s *JobStore) CheckLease(ctx context.Context, lease ports.Lease, _ time.Time) error {
	if !lease.Valid() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	var alive bool
	err := s.db.QueryRowContext(ctx, `
		SELECT true FROM rhinoq_jobs
		WHERE id = $1 AND state = 'leased' AND lease_owner = $2
		  AND lease_epoch = $3 AND lease_until > now()`,
		string(lease.JobID), lease.Owner, lease.Epoch).Scan(&alive)
	if errors.Is(err, sql.ErrNoRows) {
		return ports.LeaseLost(lease, "the stored owner, epoch or expiry no longer matches")
	}
	return err
}

// RenewLease extends the lease, checks the fence and reports a pending
// cancellation in one round trip, so a long job does not pay two queries per
// heartbeat.
func (s *JobStore) RenewLease(ctx context.Context, lease ports.Lease, _ time.Time, extension time.Duration) (ports.LeaseStatus, error) {
	if !lease.Valid() || extension <= 0 {
		return ports.LeaseStatus{}, ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	var status ports.LeaseStatus
	err := s.db.QueryRowContext(ctx, `
		UPDATE rhinoq_jobs
		SET lease_until = now() + ($1 * interval '1 millisecond')
		WHERE id = $2 AND state = 'leased' AND lease_owner = $3
		  AND lease_epoch = $4 AND lease_until > now()
		RETURNING lease_until, cancel_requested`,
		extension.Milliseconds(), string(lease.JobID), lease.Owner, lease.Epoch).
		Scan(&status.ExpiresAt, &status.CancelRequested)
	if errors.Is(err, sql.ErrNoRows) {
		return ports.LeaseStatus{}, ports.LeaseLost(lease, "the stored owner, epoch or expiry no longer matches")
	}
	return status, err
}

func (s *JobStore) Complete(ctx context.Context, lease ports.Lease, _ time.Time) error {
	if !lease.Valid() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	result, err := s.db.ExecContext(ctx, `
		WITH transitioned AS (
			UPDATE rhinoq_jobs
			SET state = 'succeeded', lease_owner = NULL, lease_until = NULL
			WHERE id = $1 AND state = 'leased' AND lease_owner = $2
			  AND lease_epoch = $3 AND lease_until > now()
			RETURNING id, attempts, lease_epoch
		)
		INSERT INTO rhinoq_attempt_events
			(job_id, attempt_number, lease_owner, lease_epoch, kind, result_state)
		SELECT id, attempts, $2, lease_epoch, 'succeeded', 'succeeded'
		FROM transitioned`,
		string(lease.JobID), lease.Owner, lease.Epoch)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ports.LeaseLost(lease, "the stored owner, epoch or expiry no longer matches")
	}
	return nil
}

// ReleaseLease gives back a job that was claimed but never started, together
// with the attempt it consumed, so a deploy does not spend one of a job's
// attempts on work that never ran.
func (s *JobStore) ReleaseLease(ctx context.Context, lease ports.Lease, _ time.Time) error {
	if !lease.Valid() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	result, err := s.db.ExecContext(ctx, `
		WITH transitioned AS (
			UPDATE rhinoq_jobs
			SET state = 'retry_wait',
			    attempts = GREATEST(attempts - 1, 0),
			    not_before = now(),
			    lease_owner = NULL,
			    lease_until = NULL
			WHERE id = $1 AND state = 'leased' AND lease_owner = $2
			  AND lease_epoch = $3 AND lease_until > now()
			RETURNING id, attempts + 1 AS released_attempt, lease_epoch
		)
		INSERT INTO rhinoq_attempt_events
			(job_id, attempt_number, lease_owner, lease_epoch, kind, result_state)
		SELECT id, released_attempt, $2, lease_epoch, 'released', 'retry_wait'
		FROM transitioned`,
		string(lease.JobID), lease.Owner, lease.Epoch)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ports.LeaseLost(lease, "the stored owner, epoch or expiry no longer matches")
	}
	return nil
}

func (s *JobStore) Fail(ctx context.Context, lease ports.Lease, _ time.Time, transition ports.FailureTransition) error {
	if !lease.Valid() {
		return ports.LeaseLost(lease, "the presented lease is incomplete")
	}
	if transition.State != job.RetryWait && transition.State != job.Dead && transition.State != job.Blocked && transition.State != job.Cancelled {
		return errors.New("invalid failure state")
	}
	var reason job.BlockedReason
	if transition.State == job.Blocked {
		reason = transition.BlockedReason
		if reason == "" {
			reason = job.BlockedUnclassified
		}
	}
	retryIn := transition.RetryIn
	if retryIn < 0 {
		retryIn = 0
	}
	eventKind, err := attempt.ResultKind(transition.State)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `
		WITH transitioned AS (
			UPDATE rhinoq_jobs
			SET state = $1,
			    not_before = now() + ($2 * interval '1 millisecond'),
			    blocked_reason = $3,
			    lease_owner = NULL,
			    lease_until = NULL
			WHERE id = $4 AND state = 'leased' AND lease_owner = $5
			  AND lease_epoch = $6 AND lease_until > now()
			RETURNING id, attempts, lease_epoch, state, blocked_reason
		), uncertain_effects AS (
			UPDATE rhinoq_effects e
			SET state = 'uncertain'
			FROM transitioned t
			WHERE e.job_id = t.id AND e.state = 'pending'
			  AND e.lease_epoch <= t.lease_epoch
			RETURNING e.id
		)
		INSERT INTO rhinoq_attempt_events
			(job_id, attempt_number, lease_owner, lease_epoch, kind, result_state,
			 failure_class, blocked_reason)
		SELECT id, attempts, $5, lease_epoch, $7, state, $8, blocked_reason
		FROM transitioned`,
		string(transition.State), retryIn.Milliseconds(), nullableString(string(reason)),
		string(lease.JobID), lease.Owner, lease.Epoch, string(eventKind),
		nullableString(transition.FailureClass))
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ports.LeaseLost(lease, "the stored owner, epoch or expiry no longer matches")
	}
	return nil
}

func (s *JobStore) RequestCancel(ctx context.Context, id ports.JobID) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN 'cancelled' ELSE state END,
		    cancel_requested = CASE WHEN state = 'leased' THEN true ELSE cancel_requested END,
		    blocked_reason = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN NULL ELSE blocked_reason END,
		    lease_owner = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN NULL ELSE lease_owner END,
		    lease_until = CASE WHEN state IN ('pending', 'retry_wait', 'blocked') THEN NULL ELSE lease_until END
		WHERE id = $1 AND state NOT IN ('succeeded', 'dead', 'cancelled')`, string(id))
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *JobStore) IsCancelRequested(ctx context.Context, id ports.JobID) (bool, error) {
	var requested bool
	err := s.db.QueryRowContext(ctx, `SELECT cancel_requested FROM rhinoq_jobs WHERE id = $1`, string(id)).Scan(&requested)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	return requested, err
}

// RequeueExpired hands timed-out work back to the queue, except for jobs that
// have taken down more workers than the protection budget allows: those are
// parked as blocked so one poison payload cannot walk through the whole fleet
// (specification 9.4).
//
// It reaps at most one batch. Without the LIMIT, a mass expiry - a deploy that
// killed every worker at once - would lock and rewrite every leased row in a
// single statement, holding locks and generating WAL in proportion to the whole
// backlog rather than to a bounded unit of work. The caller repeats while
// Saturated is set, which keeps each statement short enough to interleave with
// live claims.
func (s *JobStore) RequeueExpired(ctx context.Context, input ports.ReapInput) (ports.ReapResult, error) {
	protection := input.Protection.Normalize()
	limit := ports.NormalizeReapLimit(input.Limit)
	var result ports.ReapResult
	rows, err := s.db.QueryContext(ctx, `
		WITH expired AS (
			SELECT id, attempts, lease_owner, lease_epoch FROM rhinoq_jobs
			WHERE state = 'leased' AND lease_until <= now()
			ORDER BY lease_until, id
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		), reaped AS (
			UPDATE rhinoq_jobs j
			SET crash_count = j.crash_count + 1,
			    state = CASE WHEN j.crash_count + 1 >= $1 THEN 'blocked' ELSE 'retry_wait' END,
			    blocked_reason = CASE WHEN j.crash_count + 1 >= $1 THEN 'poison_job' ELSE NULL END,
			    not_before = now(),
			    lease_owner = NULL,
			    lease_until = NULL
			FROM expired
			WHERE j.id = expired.id
			RETURNING j.id, j.attempts, expired.lease_owner, j.lease_epoch,
			          j.state AS new_state, j.blocked_reason
		), evidence AS (
			INSERT INTO rhinoq_attempt_events
				(job_id, attempt_number, lease_owner, lease_epoch, kind,
				 result_state, blocked_reason)
			SELECT id, attempts, lease_owner, lease_epoch, 'lease_expired',
			       new_state, blocked_reason
			FROM reaped
			RETURNING job_id
		)
		SELECT r.id, r.lease_epoch, r.new_state
		FROM reaped r
		LEFT JOIN evidence e ON e.job_id = r.id`, protection.MaxWorkerCrashesPerJob, limit)
	if err != nil {
		return ports.ReapResult{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, state string
		var epoch int64
		if err := rows.Scan(&id, &epoch, &state); err != nil {
			return ports.ReapResult{}, err
		}
		result.Expired = append(result.Expired, ports.ExpiredLease{JobID: job.ID(id), Epoch: epoch})
		if job.State(state) == job.Blocked {
			result.Blocked++
		} else {
			result.Requeued++
		}
	}
	if err := rows.Err(); err != nil {
		return ports.ReapResult{}, err
	}
	result.Saturated = len(result.Expired) >= limit
	return result, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanJob(row scanner) (job.Record, error) {
	var record job.Record
	var id, state, resourceClass, blockedReason string
	if err := row.Scan(&id, &record.QueueName, &record.JobName, &record.GroupKey,
		&record.Payload, &state, &resourceClass, &record.Priority,
		&record.Attempts, &record.CrashCount, &blockedReason, &record.IdempotencyKey,
		&record.CorrelationID, &record.CreatedAt, &record.NotBefore,
		&record.LeaseOwner, &record.LeaseEpoch, &record.LeaseUntil, &record.CancelRequested); err != nil {
		return job.Record{}, err
	}
	record.ID = job.ID(id)
	record.State = job.State(state)
	record.ResourceClass = job.Class(resourceClass)
	record.BlockedReason = job.BlockedReason(blockedReason)
	return record, nil
}

func scanAttemptEvent(row scanner) (attempt.Event, error) {
	var event attempt.Event
	var id, kind, state, blockedReason string
	if err := row.Scan(&event.Sequence, &id, &event.Attempt, &event.LeaseOwner,
		&event.LeaseEpoch, &kind, &state, &event.FailureClass, &blockedReason,
		&event.OccurredAt); err != nil {
		return attempt.Event{}, err
	}
	event.JobID = job.ID(id)
	event.Kind = attempt.Kind(kind)
	event.ResultState = job.State(state)
	event.BlockedReason = job.BlockedReason(blockedReason)
	return event, nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func newID(prefix string) (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate %s id: %w", prefix, err)
	}
	return prefix + "_" + hex.EncodeToString(bytes), nil
}
