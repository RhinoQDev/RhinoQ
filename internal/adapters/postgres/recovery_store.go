package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/domain/job"
	"github.com/rhinoq/rhinoq/internal/domain/recovery"
)

type RecoveryStore struct {
	db *sql.DB
}

func NewRecoveryStore(db *sql.DB) (*RecoveryStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &RecoveryStore{db: db}, nil
}

func (s *RecoveryStore) ListAttention(ctx context.Context, query recovery.AttentionQuery) ([]recovery.AttentionItem, error) {
	if err := recovery.ValidateAttentionQuery(query); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT kind, job_id, queue_name, job_state, reference_id, reason, observed_at
		FROM (
			SELECT 'dead_job' AS kind, j.id AS job_id, j.name AS queue_name, j.state AS job_state,
			       '' AS reference_id, 'job exhausted its execution policy' AS reason, j.created_at AS observed_at
			FROM rhinoq_jobs j WHERE j.state = 'dead'
			UNION ALL
			SELECT 'execution_blocked', j.id, j.name, j.state, '',
			       CASE j.blocked_reason
			           WHEN 'poison_job' THEN 'job repeatedly took its worker down and was parked'
			           ELSE 'execution requires an operator decision'
			       END, j.created_at
			FROM rhinoq_jobs j WHERE j.state = 'blocked'
			UNION ALL
			SELECT 'effect_uncertain', j.id, j.name, j.state, e.id,
			       'external effect may have happened', e.created_at
			FROM rhinoq_effects e
			JOIN rhinoq_jobs j ON j.id = e.job_id
			WHERE e.state = 'uncertain'
			UNION ALL
			SELECT 'outcome_mismatch', j.id, j.name, j.state, o.id,
			       COALESCE(NULLIF(o.reason, ''), 'declared business outcome was not achieved'), o.updated_at
			FROM rhinoq_outcomes o
			JOIN rhinoq_jobs j ON j.id = o.job_id
			WHERE o.state IN ('mismatch', 'unverifiable')
		) attention
		WHERE ($1 = '' OR queue_name = $1)
		ORDER BY observed_at DESC, job_id DESC, kind
		LIMIT $2 OFFSET $3`, query.Queue, query.Limit, query.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]recovery.AttentionItem, 0, query.Limit)
	for rows.Next() {
		var item recovery.AttentionItem
		if err := rows.Scan(
			&item.Kind, &item.JobID, &item.Queue, &item.JobState,
			&item.ReferenceID, &item.Reason, &item.ObservedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *RecoveryStore) Replay(ctx context.Context, request recovery.ReplayRequest) (job.Record, recovery.AuditRecord, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	defer tx.Rollback()

	row := tx.QueryRowContext(ctx, `SELECT `+jobColumns+`
		FROM rhinoq_jobs j
		WHERE j.id = $1
		FOR UPDATE`, request.JobID)
	record, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return job.Record{}, recovery.AuditRecord{}, ErrNotFound
	}
	if err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT id, job_id, name, idempotency_key, state, irreversible,
		       COALESCE(external_ref, ''), created_at, lease_epoch
		FROM rhinoq_effects
		WHERE job_id = $1`, request.JobID)
	if err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	effects := make([]effect.Record, 0)
	for rows.Next() {
		var item effect.Record
		if err := rows.Scan(
			&item.ID, &item.JobID, &item.Name, &item.IdempotencyKey,
			&item.State, &item.Irreversible, &item.ExternalRef, &item.CreatedAt, &item.LeaseEpoch,
		); err != nil {
			rows.Close()
			return job.Record{}, recovery.AuditRecord{}, err
		}
		effects = append(effects, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return job.Record{}, recovery.AuditRecord{}, err
	}
	if err := rows.Close(); err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	if err := recovery.ValidateReplay(record, effects, request); err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}

	auditID, err := newID("audit")
	if err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	var previous string
	err = tx.QueryRowContext(ctx, `
		SELECT row_hash
		FROM rhinoq_audit
		WHERE job_id = $1
		ORDER BY sequence DESC
		LIMIT 1`, request.JobID).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	audit := recovery.AuditRecord{
		ID: auditID, JobID: record.ID, Action: "job_replayed",
		Actor: request.Actor, Reason: request.Reason, OccurredAt: request.RequestedAt,
		PrevHash: previous,
	}
	audit.RowHash = recovery.HashAudit(previous, audit)

	// A replayed job starts its crash budget again: an operator who decided the
	// payload is safe should not have it parked again by the previous crashes.
	result, err := tx.ExecContext(ctx, `
		UPDATE rhinoq_jobs
		SET state = 'pending', not_before = $1, lease_owner = NULL, lease_until = NULL,
		    cancel_requested = false, blocked_reason = NULL, crash_count = 0
		WHERE id = $2 AND state IN ('dead', 'blocked')`, request.RequestedAt, request.JobID)
	if err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return job.Record{}, recovery.AuditRecord{}, err
		}
		return job.Record{}, recovery.AuditRecord{}, recovery.ErrReplayState
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO rhinoq_audit
			(id, job_id, action, actor, reason, occurred_at, prev_hash, row_hash)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		audit.ID, audit.JobID, audit.Action, audit.Actor, audit.Reason,
		audit.OccurredAt, audit.PrevHash, audit.RowHash,
	); err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return job.Record{}, recovery.AuditRecord{}, err
	}
	record.State = job.Pending
	record.NotBefore = request.RequestedAt
	record.LeaseOwner = ""
	record.LeaseUntil = time.Time{}
	record.CancelRequested = false
	record.BlockedReason = ""
	record.CrashCount = 0
	return record, audit, nil
}

func (s *RecoveryStore) ListAudit(ctx context.Context, jobID job.ID, offset, limit int) ([]recovery.AuditRecord, error) {
	if jobID == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, job_id, action, actor, reason, occurred_at, prev_hash, row_hash
		FROM rhinoq_audit
		WHERE job_id = $1
		ORDER BY sequence DESC
		LIMIT $2 OFFSET $3`, jobID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]recovery.AuditRecord, 0, limit)
	for rows.Next() {
		var record recovery.AuditRecord
		if err := rows.Scan(
			&record.ID, &record.JobID, &record.Action, &record.Actor,
			&record.Reason, &record.OccurredAt, &record.PrevHash, &record.RowHash,
		); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}
