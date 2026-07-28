package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/correlation"
	"github.com/madebyduy/RhinoQ/internal/domain/effect"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

var _ ports.EffectStore = (*EffectStore)(nil)
var _ ports.EffectReader = (*EffectStore)(nil)
var _ ports.ExternalEffectStore = (*EffectStore)(nil)

type EffectStore struct {
	db *sql.DB
}

func NewEffectStore(db *sql.DB) (*EffectStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &EffectStore{db: db}, nil
}

func (s *EffectStore) CheckLease(ctx context.Context, lease ports.Lease, _ time.Time) error {
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

// effectColumns is the projection every effect read uses, so the scan order
// cannot drift between queries.
const effectColumns = `id, COALESCE(job_id, ''), source_system, source_id,
	COALESCE(subject_type, ''), COALESCE(subject_id, ''), COALESCE(business_key, ''),
	name, idempotency_key, state, irreversible,
	COALESCE(external_ref, ''), created_at, lease_epoch`

type effectScanner interface{ Scan(dest ...any) error }

func scanEffect(row effectScanner) (effect.Record, error) {
	var record effect.Record
	err := row.Scan(
		&record.ID, &record.JobID,
		&record.Execution.SourceSystem, &record.Execution.SourceID,
		&record.Subject.Type, &record.Subject.ID, &record.BusinessKey,
		&record.Name, &record.IdempotencyKey, &record.State,
		&record.Irreversible, &record.ExternalRef,
		&record.CreatedAt, &record.LeaseEpoch,
	)
	return record, err
}

// BeginEffect opens the ledger entry only if the caller still owns the job. The
// fence lives inside the INSERT, so there is no window between checking the
// lease and recording that money is about to move (specification 41.3).
//
// This is the RhinoQ-execution path. An effect opened for work another system
// ran cannot be fenced this way, because there is no lease to present; see
// BeginExternalEffect.
func (s *EffectStore) BeginEffect(ctx context.Context, lease ports.Lease, _ time.Time, record effect.Record) (effect.Record, error) {
	if !lease.Valid() || string(lease.JobID) != record.JobID {
		return effect.Record{}, ports.LeaseLost(lease, "the presented lease does not own this effect")
	}
	row := s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_effects
			(id, job_id, source_system, source_id, subject_type, subject_id,
			 business_key, name, idempotency_key, state, irreversible,
			 external_ref, created_at, lease_epoch)
		SELECT $1, $2, 'rhinoq', $2, $11, $12, $13, $3, $4, $5, $6, $7, $8, $9
		WHERE EXISTS (
			SELECT 1 FROM rhinoq_jobs
			WHERE id = $2 AND state = 'leased' AND lease_owner = $10
			  AND lease_epoch = $9 AND lease_until > now()
		)
		ON CONFLICT ON CONSTRAINT rhinoq_effects_execution_unique
		DO UPDATE SET name = EXCLUDED.name
		RETURNING `+effectColumns,
		string(record.ID), record.JobID, record.Name, record.IdempotencyKey, string(record.State),
		record.Irreversible, nullableString(record.ExternalRef), record.CreatedAt,
		lease.Epoch, lease.Owner,
		nullableString(record.Subject.Type), nullableString(record.Subject.ID),
		nullableString(record.BusinessKey),
	)
	stored, err := scanEffect(row)
	if errors.Is(err, sql.ErrNoRows) {
		return effect.Record{}, ports.LeaseLost(lease, "the lease expired before the effect could be opened")
	}
	return stored, err
}

// BeginExternalEffect records an effect for an execution RhinoQ did not run.
//
// It is deliberately not fenced. There is no lease, so nothing can prove the
// caller still owns the work, and pretending otherwise would be worse than
// saying so: deduplication rests on the execution reference plus the
// idempotency key, which is the guarantee an external caller can actually
// provide. A second call with the same key returns the first record.
func (s *EffectStore) BeginExternalEffect(
	ctx context.Context,
	record effect.Record,
) (effect.Record, error) {
	if record.Execution.IsRhinoQJob() {
		return effect.Record{}, errors.New(
			"a RhinoQ execution must open its effect through BeginEffect so the lease can fence it")
	}
	execution, err := record.Execution.Normalize()
	if err != nil {
		return effect.Record{}, err
	}
	row := s.db.QueryRowContext(ctx, `
		INSERT INTO rhinoq_effects
			(id, job_id, source_system, source_id, subject_type, subject_id,
			 business_key, name, idempotency_key, state, irreversible,
			 external_ref, created_at, lease_epoch)
		VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0)
		ON CONFLICT ON CONSTRAINT rhinoq_effects_execution_unique
		DO UPDATE SET name = EXCLUDED.name
		RETURNING `+effectColumns,
		string(record.ID), execution.SourceSystem, execution.SourceID,
		nullableString(record.Subject.Type), nullableString(record.Subject.ID),
		nullableString(record.BusinessKey),
		record.Name, record.IdempotencyKey, string(record.State),
		record.Irreversible, nullableString(record.ExternalRef), record.CreatedAt,
	)
	return scanEffect(row)
}

func (s *EffectStore) GetEffect(ctx context.Context, jobID, name, idempotencyKey string) (effect.Record, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+effectColumns+`
		FROM rhinoq_effects
		WHERE job_id = $1 AND name = $2 AND idempotency_key = $3`, jobID, name, idempotencyKey)
	record, err := scanEffect(row)
	if errors.Is(err, sql.ErrNoRows) {
		return effect.Record{}, false, nil
	}
	return record, err == nil, err
}

// ListSubjectEffects reads the ledger for one business subject, whichever
// system produced the entries. It is what makes a subject timeline possible
// without a RhinoQ job to start from.
func (s *EffectStore) ListSubjectEffects(
	ctx context.Context,
	subject correlation.SubjectRef,
	offset, limit int,
) ([]effect.Record, error) {
	subject, err := subject.Normalize()
	if err != nil {
		return nil, err
	}
	if offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("non-negative offset and limit between 1 and 1000 are required")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+effectColumns+`
		FROM rhinoq_effects
		WHERE subject_type = $1 AND subject_id = $2
		ORDER BY created_at, id
		LIMIT $3 OFFSET $4`, subject.Type, subject.ID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]effect.Record, 0, limit)
	for rows.Next() {
		record, err := scanEffect(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *EffectStore) ListEffects(
	ctx context.Context,
	jobID string,
	offset, limit int,
) ([]effect.Record, error) {
	if jobID == "" || offset < 0 || limit <= 0 || limit > 1000 {
		return nil, errors.New("job id, non-negative offset and limit between 1 and 1000 are required")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+effectColumns+`
		FROM rhinoq_effects
		WHERE job_id = $1
		ORDER BY created_at, id
		LIMIT $2 OFFSET $3`, jobID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]effect.Record, 0, limit)
	for rows.Next() {
		record, err := scanEffect(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

// ConfirmEffect records a worker-authored transition and is fenced for the same
// reason as BeginEffect: an execution that lost the job must not be able to
// declare its effect confirmed.
func (s *EffectStore) ConfirmEffect(ctx context.Context, lease ports.Lease, _ time.Time, record effect.Record) error {
	if !lease.Valid() || string(lease.JobID) != record.JobID {
		return ports.LeaseLost(lease, "the presented lease does not own this effect")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects e
		SET state = $1, external_ref = $2
		WHERE e.id = $3
		  AND EXISTS (
		      SELECT 1 FROM rhinoq_jobs
		      WHERE id = e.job_id AND state = 'leased' AND lease_owner = $4
		        AND lease_epoch = $5 AND lease_until > now()
		  )`, string(record.State), nullableString(record.ExternalRef), string(record.ID),
		lease.Owner, lease.Epoch)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ports.LeaseLost(lease, "the lease expired before the effect could be confirmed")
	}
	return nil
}

// MarkPendingUncertain downgrades effects left open by executions that died.
// The epoch bound is what keeps the sweep from touching an effect the next
// execution has already opened.
func (s *EffectStore) MarkPendingUncertain(ctx context.Context, expired []ports.ExpiredLease) (int, error) {
	if len(expired) == 0 {
		return 0, nil
	}
	args := make([]any, 0, len(expired)*2)
	conditions := make([]string, 0, len(expired))
	for _, item := range expired {
		args = append(args, string(item.JobID), item.Epoch)
		conditions = append(conditions, fmt.Sprintf("(job_id = $%d AND lease_epoch <= $%d)", len(args)-1, len(args)))
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects
		SET state = 'uncertain'
		WHERE state = 'pending' AND (`+strings.Join(conditions, " OR ")+`)`, args...)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	return int(affected), err
}

// SaveEffect persists a transition authored by RhinoQ itself, such as the
// reaper moving a pending effect to uncertain once its execution died.
func (s *EffectStore) SaveEffect(ctx context.Context, record effect.Record) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_effects
		SET state = $1, external_ref = $2
		WHERE id = $3`, string(record.State), nullableString(record.ExternalRef), string(record.ID))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrNotFound
	}
	return nil
}
