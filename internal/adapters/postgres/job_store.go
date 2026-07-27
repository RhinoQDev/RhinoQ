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

	"github.com/rhinoq/rhinoq/internal/domain/admission"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/ports"
)

var (
	ErrLeaseLost = ports.ErrLeaseLost
	ErrNotFound  = ports.ErrJobNotFound
)

// jobColumns is the projection every read uses. Keeping it in one place stops
// the scan order from drifting between queries.
const jobColumns = `j.id, j.name, j.payload, j.state, j.class, j.priority, j.attempts,
	j.crash_count, COALESCE(j.blocked_reason, ''), COALESCE(j.idempotency_key, ''),
	COALESCE(j.correlation_id, ''), j.created_at, j.not_before,
	COALESCE(j.lease_owner, ''), j.lease_epoch,
	COALESCE(j.lease_until, 'epoch'::timestamptz), j.cancel_requested`

// effectivePrioritySQL mirrors job.EffectivePriority: priority first, aged
// upwards by waiting time and capped, so nothing starves. Change both together.
const effectivePrioritySQL = `(j.priority + LEAST(EXTRACT(epoch FROM (now() - j.not_before)) / 3600.0, 5.0))`

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
	if input.Name == "" {
		return "", job.ErrEmptyName
	}
	if err := job.ValidatePayload(input.Payload, job.DefaultMaxPayloadBytes); err != nil {
		return "", err
	}
	if input.Priority < job.MinPriority || input.Priority > job.MaxPriority {
		return "", job.ErrInvalidPriority
	}
	class, err := job.NormalizeClass(input.Class)
	if err != nil {
		return "", err
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

	deferBy, err := s.admitTx(ctx, tx, input.Name, class.IsCritical())
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
			(id, name, payload, state, class, priority, idempotency_key, correlation_id, not_before)
		VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7,
			GREATEST(COALESCE($8::timestamptz, now()), now()) + ($9 * interval '1 millisecond'))
		ON CONFLICT (name, idempotency_key)
		DO UPDATE SET name = EXCLUDED.name
		RETURNING id`,
		id, input.Name, input.Payload, string(class), input.Priority,
		idempotency, nullableString(input.CorrelationID),
		nullableTime(input.NotBefore), deferBy.Milliseconds(),
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
func (s *JobStore) admitTx(ctx context.Context, tx *sql.Tx, name string, critical bool) (time.Duration, error) {
	var maxPending, reserved, delayMS, retryAfterMS sql.NullInt64
	var mode sql.NullString
	err := tx.QueryRowContext(ctx, `
		SELECT admission_max_pending, admission_reserved_critical, admission_overflow_mode,
		       admission_delay_ms, admission_retry_after_ms
		FROM rhinoq_queue_controls WHERE queue_name = $1`, name).
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
			WHERE name = $1 AND state IN ('pending', 'retry_wait')
			LIMIT $2
		) capped`, name, policy.Capacity(critical)).Scan(&pending); err != nil {
		return 0, err
	}
	decision, err := policy.Decide(name, pending, critical)
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
	args := []any{input.Name}
	var query strings.Builder
	query.WriteString(`SELECT ` + jobColumns + ` FROM rhinoq_jobs j WHERE ($1 = '' OR j.name = $1)`)
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

func (s *JobStore) JobCounts(ctx context.Context, name string) (map[job.State]int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT state, count(*)
		FROM rhinoq_jobs
		WHERE ($1 = '' OR name = $1)
		GROUP BY state`, name)
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

// Claim locks a batch of eligible jobs, reserves rate-limit slots one queue at a
// time rather than one job at a time, and leases the survivors with a single
// UPDATE. The cost is two statements plus one per distinct queue in the batch,
// no matter how many jobs are claimed.
func (s *JobStore) Claim(ctx context.Context, input ports.ClaimInput) ([]job.Record, error) {
	if input.Owner == "" || input.Limit <= 0 || input.LeaseDuration <= 0 {
		return nil, errors.New("claim requires an owner, a positive limit and a lease duration")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	candidates, err := s.lockCandidates(ctx, tx, input.Limit)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return []job.Record{}, tx.Commit()
	}

	wanted := make(map[string]int, len(candidates))
	for _, item := range candidates {
		wanted[item.queue]++
	}
	granted := make(map[string]int, len(wanted))
	for queue, want := range wanted {
		allowed, err := s.reserveRateSlotsTx(ctx, tx, queue, want)
		if err != nil {
			return nil, err
		}
		granted[queue] = allowed
	}

	ids := make([]string, 0, input.Limit)
	for _, item := range candidates {
		if len(ids) == input.Limit {
			break
		}
		if granted[item.queue] <= 0 {
			continue
		}
		granted[item.queue]--
		ids = append(ids, item.id)
	}
	if len(ids) == 0 {
		return []job.Record{}, tx.Commit()
	}

	claimed, err := s.leaseTx(ctx, tx, input, ids)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return claimed, nil
}

type claimCandidate struct{ id, queue string }

// lockCandidates over-fetches on purpose: a queue whose rate window saturates
// mid-batch would otherwise return an empty claim and let its jobs, which sort
// first, starve every other queue on the next poll.
func (s *JobStore) lockCandidates(ctx context.Context, tx *sql.Tx, limit int) ([]claimCandidate, error) {
	candidateLimit := limit * 4
	if candidateLimit > maxClaimCandidates {
		candidateLimit = maxClaimCandidates
	}
	if candidateLimit < limit {
		candidateLimit = limit
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT j.id, j.name
		FROM rhinoq_jobs j
		LEFT JOIN rhinoq_queue_controls qc ON qc.queue_name = j.name
		WHERE j.state IN ('pending', 'retry_wait')
		  AND j.not_before <= now()
		  AND qc.paused_at IS NULL
		  AND (
		      qc.rate_limit_max IS NULL
		      OR qc.rate_window_started_at IS NULL
		      OR qc.rate_window_started_at + (qc.rate_limit_window_ms * interval '1 millisecond') <= now()
		      OR qc.rate_window_count < qc.rate_limit_max
		  )
		ORDER BY `+effectivePrioritySQL+` DESC, j.created_at, j.id
		FOR UPDATE OF j SKIP LOCKED
		LIMIT $1`, candidateLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]claimCandidate, 0, candidateLimit)
	for rows.Next() {
		var item claimCandidate
		if err := rows.Scan(&item.id, &item.queue); err != nil {
			return nil, err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, rows.Close()
}

// leaseTx takes the whole batch in one UPDATE and returns the leases with the
// expiry and epoch the database itself assigned.
func (s *JobStore) leaseTx(ctx context.Context, tx *sql.Tx, input ports.ClaimInput, ids []string) ([]job.Record, error) {
	args := make([]any, 0, len(ids)+2)
	args = append(args, input.Owner, input.LeaseDuration.Milliseconds())
	placeholders := make([]string, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
		placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
	}
	rows, err := tx.QueryContext(ctx, `
		UPDATE rhinoq_jobs j
		SET state = 'leased',
		    attempts = j.attempts + 1,
		    blocked_reason = NULL,
		    lease_owner = $1,
		    lease_epoch = j.lease_epoch + 1,
		    lease_until = now() + ($2 * interval '1 millisecond')
		WHERE j.id IN (`+strings.Join(placeholders, ", ")+`)
		RETURNING `+jobColumns, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	claimed := make([]job.Record, 0, len(ids))
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
	return claimed, rows.Close()
}

func (s *JobStore) PauseQueue(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("queue name is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_queue_controls (queue_name, paused_at)
		VALUES ($1, now())
		ON CONFLICT (queue_name) DO UPDATE SET paused_at = now()`, name)
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
		ON CONFLICT (queue_name) DO UPDATE
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
		ON CONFLICT (queue_name) DO UPDATE
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
		UPDATE rhinoq_jobs
		SET state = 'succeeded', lease_owner = NULL, lease_until = NULL
		WHERE id = $1 AND state = 'leased' AND lease_owner = $2
		  AND lease_epoch = $3 AND lease_until > now()`,
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
		UPDATE rhinoq_jobs
		SET state = 'retry_wait',
		    attempts = GREATEST(attempts - 1, 0),
		    not_before = now(),
		    lease_owner = NULL,
		    lease_until = NULL
		WHERE id = $1 AND state = 'leased' AND lease_owner = $2
		  AND lease_epoch = $3 AND lease_until > now()`,
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
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = $1,
		    not_before = now() + ($2 * interval '1 millisecond'),
		    blocked_reason = $3,
		    lease_owner = NULL,
		    lease_until = NULL
		WHERE id = $4 AND state = 'leased' AND lease_owner = $5
		  AND lease_epoch = $6 AND lease_until > now()`,
		string(transition.State), retryIn.Milliseconds(), nullableString(string(reason)),
		string(lease.JobID), lease.Owner, lease.Epoch)
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
func (s *JobStore) RequeueExpired(ctx context.Context, input ports.ReapInput) (ports.ReapResult, error) {
	protection := input.Protection.Normalize()
	var result ports.ReapResult
	rows, err := s.db.QueryContext(ctx, `
		WITH expired AS (
			SELECT id, lease_epoch FROM rhinoq_jobs
			WHERE state = 'leased' AND lease_until <= now()
			FOR UPDATE SKIP LOCKED
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
			RETURNING j.id, j.lease_epoch, j.state AS new_state
		)
		SELECT id, lease_epoch, new_state FROM reaped`, protection.MaxWorkerCrashesPerJob)
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
	return result, rows.Err()
}

// reserveRateSlotsTx reserves up to want slots for a queue in its current fixed
// window and returns how many were granted. Reserving a batch at once keeps the
// claim path at one statement per queue instead of one per job.
func (s *JobStore) reserveRateSlotsTx(ctx context.Context, tx *sql.Tx, name string, want int) (int, error) {
	var granted int
	err := tx.QueryRowContext(ctx, `
		WITH locked AS (
			SELECT queue_name, rate_limit_max,
			       CASE
			           WHEN rate_window_started_at IS NULL
			             OR rate_window_started_at + (rate_limit_window_ms * interval '1 millisecond') <= now()
			           THEN true ELSE false
			       END AS window_expired,
			       rate_window_count
			FROM rhinoq_queue_controls
			WHERE queue_name = $1 AND rate_limit_max IS NOT NULL
			FOR UPDATE
		), reservation AS (
			SELECT queue_name, window_expired,
			       CASE WHEN window_expired THEN 0 ELSE rate_window_count END AS used,
			       LEAST($2, GREATEST(rate_limit_max -
			           CASE WHEN window_expired THEN 0 ELSE rate_window_count END, 0)) AS granted
			FROM locked
		)
		UPDATE rhinoq_queue_controls qc
		SET rate_window_started_at = CASE WHEN reservation.window_expired THEN now() ELSE qc.rate_window_started_at END,
		    rate_window_count = reservation.used + reservation.granted,
		    updated_at = now()
		FROM reservation
		WHERE qc.queue_name = reservation.queue_name
		RETURNING reservation.granted`, name, want).Scan(&granted)
	if errors.Is(err, sql.ErrNoRows) {
		// No controls row, or no rate limit configured: the queue is unlimited.
		return want, nil
	}
	if err != nil {
		return 0, err
	}
	return granted, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanJob(row scanner) (job.Record, error) {
	var record job.Record
	var id, state, class, blockedReason string
	if err := row.Scan(&id, &record.Name, &record.Payload, &state, &class, &record.Priority,
		&record.Attempts, &record.CrashCount, &blockedReason, &record.IdempotencyKey,
		&record.CorrelationID, &record.CreatedAt, &record.NotBefore,
		&record.LeaseOwner, &record.LeaseEpoch, &record.LeaseUntil, &record.CancelRequested); err != nil {
		return job.Record{}, err
	}
	record.ID = job.ID(id)
	record.State = job.State(state)
	record.Class = job.Class(class)
	record.BlockedReason = job.BlockedReason(blockedReason)
	return record, nil
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
