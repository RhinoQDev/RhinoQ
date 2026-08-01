package postgres

import (
	"context"
	"database/sql"
	"errors"
	"github.com/madebyduy/RhinoQ/internal/domain/repair"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type RepairStore struct{ db *sql.DB }

func NewRepairStore(db *sql.DB) (*RepairStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &RepairStore{db: db}, nil
}

const repairColumns = `id, rule_id, subject_type, subject_id, invariant_version, handler, parameters,
	state, proposed_by, COALESCE(approved_by,''), COALESCE(approval_reason,''), COALESCE(preview,''),
	COALESCE(precondition,''), COALESCE(outcome,''), version, created_at, updated_at`

func scanRepair(row rowScanner) (repair.Record, error) {
	var r repair.Record
	err := row.Scan(&r.ID, &r.FindingKey.RuleID, &r.FindingKey.SubjectType, &r.FindingKey.SubjectID, &r.FindingKey.ObservedInvariantVersion, &r.Handler, &r.Parameters, &r.State, &r.ProposedBy, &r.ApprovedBy, &r.ApprovalReason, &r.Preview, &r.Precondition, &r.Outcome, &r.Version, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}
func (s *RepairStore) CreateRepair(ctx context.Context, r repair.Record) (repair.Record, error) {
	stored, err := scanRepair(s.db.QueryRowContext(ctx, `INSERT INTO rhinoq_repairs (id,rule_id,subject_type,subject_id,invariant_version,handler,parameters,state,proposed_by,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING `+repairColumns, r.ID, r.FindingKey.RuleID, r.FindingKey.SubjectType, r.FindingKey.SubjectID, r.FindingKey.ObservedInvariantVersion, r.Handler, []byte(r.Parameters), r.State, r.ProposedBy, r.Version, r.CreatedAt, r.UpdatedAt))
	if err != nil {
		return repair.Record{}, mapAlreadyExists(err)
	}
	return stored, nil
}
func (s *RepairStore) GetRepair(ctx context.Context, id repair.ID) (repair.Record, bool, error) {
	r, err := scanRepair(s.db.QueryRowContext(ctx, `SELECT `+repairColumns+` FROM rhinoq_repairs WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return repair.Record{}, false, nil
	}
	return r, err == nil, err
}
func (s *RepairStore) SaveRepair(ctx context.Context, r repair.Record, expected int64) (repair.Record, error) {
	if expected <= 0 || r.Version != expected+1 {
		return repair.Record{}, ports.ErrVersionConflict
	}
	updated, err := scanRepair(s.db.QueryRowContext(ctx, `UPDATE rhinoq_repairs SET state=$2,approved_by=$3,approval_reason=$4,preview=$5,precondition=$6,outcome=$7,version=$8,updated_at=$9 WHERE id=$1 AND version=$10 RETURNING `+repairColumns, r.ID, r.State, nullableString(r.ApprovedBy), nullableString(r.ApprovalReason), nullableString(r.Preview), nullableString(r.Precondition), nullableString(r.Outcome), r.Version, r.UpdatedAt, expected))
	if errors.Is(err, sql.ErrNoRows) {
		if _, found, getErr := s.GetRepair(ctx, r.ID); getErr != nil {
			return repair.Record{}, getErr
		} else if !found {
			return repair.Record{}, ports.ErrRepairNotFound
		}
		return repair.Record{}, ports.ErrVersionConflict
	}
	return updated, err
}
