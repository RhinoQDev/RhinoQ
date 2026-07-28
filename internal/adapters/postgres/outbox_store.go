package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

type OutboxStore struct {
	db *sql.DB
}

func NewOutboxStore(db *sql.DB) (*OutboxStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &OutboxStore{db: db}, nil
}

func (s *OutboxStore) Append(ctx context.Context, event ports.OutboxEvent) error {
	if event.AggregateType == "" || event.AggregateID == "" || event.EventType == "" {
		return errors.New("outbox event identity is required")
	}
	payload, err := json.RawMessage(event.Payload).MarshalJSON()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO rhinoq_outbox (aggregate_type, aggregate_id, event_type, payload)
		VALUES ($1, $2, $3, $4::jsonb)`, event.AggregateType, event.AggregateID, event.EventType, payload)
	return err
}

func (s *OutboxStore) ClaimUnpublished(ctx context.Context, limit int) ([]ports.OutboxEvent, error) {
	if limit <= 0 {
		return nil, errors.New("outbox claim limit must be positive")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	claimID, err := newID("outbox")
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, aggregate_type, aggregate_id, event_type, payload
		FROM rhinoq_outbox
		WHERE published_at IS NULL
		  AND claimed_at IS NULL
		ORDER BY created_at, id
		FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]ports.OutboxEvent, 0, limit)
	for rows.Next() {
		var event ports.OutboxEvent
		if err := rows.Scan(&event.ID, &event.AggregateType, &event.AggregateID, &event.EventType, &event.Payload); err != nil {
			return nil, err
		}
		event.ClaimID = claimID
		if _, err := tx.ExecContext(ctx, `UPDATE rhinoq_outbox SET claimed_at = now(), claim_id = $1 WHERE id = $2`, claimID, event.ID); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return events, nil
}

func (s *OutboxStore) MarkPublished(ctx context.Context, eventID int64, claimID string) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE rhinoq_outbox SET published_at = now()
		WHERE id = $1 AND claim_id = $2 AND published_at IS NULL`, eventID, claimID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}
