package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

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

// ClaimUnpublished takes a batch in a single statement. The previous
// implementation selected the batch and then issued one UPDATE per event inside
// the loop, so claiming N events cost N+1 round trips while holding a
// transaction open over all of them.
//
// It also reclaims batches whose claim went stale. The claim filter skips
// claimed rows, so a publisher that died between claiming and marking used to
// strand its batch permanently: nothing would ever look at those rows again.
func (s *OutboxStore) ClaimUnpublished(
	ctx context.Context,
	limit int,
	reclaimAfter time.Duration,
) ([]ports.OutboxEvent, error) {
	if limit <= 0 {
		return nil, errors.New("outbox claim limit must be positive")
	}
	if reclaimAfter <= 0 {
		reclaimAfter = ports.DefaultOutboxReclaimAfter
	}
	claimID, err := newID("outbox")
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		WITH candidates AS (
			SELECT id FROM rhinoq_outbox
			WHERE published_at IS NULL
			  AND (
			      claimed_at IS NULL
			      OR claimed_at <= now() - ($3::bigint * interval '1 millisecond')
			  )
			ORDER BY created_at, id
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		UPDATE rhinoq_outbox o
		SET claimed_at = now(), claim_id = $1
		FROM candidates c
		WHERE o.id = c.id
		RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload`,
		claimID, limit, reclaimAfter.Milliseconds())
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
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// UPDATE ... RETURNING has no ordering guarantee, but publication order must
	// follow creation order for a consumer reading an aggregate's timeline.
	sort.Slice(events, func(i, j int) bool { return events[i].ID < events[j].ID })
	return events, nil
}

func (s *OutboxStore) MarkPublishedBatch(ctx context.Context, claimID string, ids []int64) (int, error) {
	return s.settleBatch(ctx, claimID, ids, `
		UPDATE rhinoq_outbox
		SET published_at = now()
		WHERE claim_id = $1 AND published_at IS NULL AND id = ANY($2::bigint[])`)
}

// MarkFailedBatch releases a claim without publishing. Without it a failed
// publish would leave the batch claimed until the reclaim timeout, delaying
// every event behind a transient transport error.
func (s *OutboxStore) MarkFailedBatch(ctx context.Context, claimID string, ids []int64) (int, error) {
	return s.settleBatch(ctx, claimID, ids, `
		UPDATE rhinoq_outbox
		SET claimed_at = NULL, claim_id = NULL
		WHERE claim_id = $1 AND published_at IS NULL AND id = ANY($2::bigint[])`)
}

// settleBatch applies one statement to a whole claimed batch. The claim id is
// part of the predicate, so a publisher that lost its claim to the reclaim
// sweep cannot settle rows another publisher now owns.
func (s *OutboxStore) settleBatch(ctx context.Context, claimID string, ids []int64, query string) (int, error) {
	if claimID == "" {
		return 0, errors.New("outbox claim id is required")
	}
	if len(ids) == 0 {
		return 0, nil
	}
	result, err := s.db.ExecContext(ctx, query, claimID, int64ArrayLiteral(ids))
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(affected), nil
}

// int64ArrayLiteral renders a PostgreSQL array literal. The store accepts any
// database/sql driver, so it cannot depend on a driver-specific array type such
// as pq.Int64Array or pgx's encoder. Formatting int64 values cannot inject:
// strconv only ever produces digits and a leading minus.
func int64ArrayLiteral(ids []int64) string {
	var buf strings.Builder
	buf.WriteByte('{')
	for index, id := range ids {
		if index > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(strconv.FormatInt(id, 10))
	}
	buf.WriteByte('}')
	return buf.String()
}
