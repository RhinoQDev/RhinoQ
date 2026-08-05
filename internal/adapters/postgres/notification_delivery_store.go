package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
	"github.com/madebyduy/RhinoQ/internal/ports"
)

type NotificationDeliveryStore struct{ db *sql.DB }

func NewNotificationDeliveryStore(db *sql.DB) (*NotificationDeliveryStore, error) {
	if db == nil {
		return nil, errors.New("postgres database is required")
	}
	return &NotificationDeliveryStore{db: db}, nil
}

const notificationDeliveryColumns = `id,event_id,destination_id,state,attempts,
	COALESCE(last_error,''),version,created_at,updated_at,sent_at,
	COALESCE(next_attempt_at,updated_at),COALESCE(lease_owner,''),lease_until,
	COALESCE(message_payload::text,'')`

const notificationDeliveryColumnsAliased = `delivery.id,delivery.event_id,delivery.destination_id,delivery.state,delivery.attempts,
	COALESCE(delivery.last_error,''),delivery.version,delivery.created_at,delivery.updated_at,delivery.sent_at,
	COALESCE(delivery.next_attempt_at,delivery.updated_at),COALESCE(delivery.lease_owner,''),delivery.lease_until,
	COALESCE(delivery.message_payload::text,'')`

func scanNotificationDelivery(row rowScanner) (notificationdelivery.Record, error) {
	var record notificationdelivery.Record
	var sent, leaseUntil sql.NullTime
	err := row.Scan(&record.ID, &record.EventID, &record.DestinationID, &record.State,
		&record.Attempts, &record.LastError, &record.Version, &record.CreatedAt, &record.UpdatedAt, &sent,
		&record.NextAttemptAt, &record.LeaseOwner, &leaseUntil, &record.Payload)
	if sent.Valid {
		record.SentAt = sent.Time
	}
	if leaseUntil.Valid {
		record.LeaseUntil = leaseUntil.Time
	}
	return record, err
}

func (s *NotificationDeliveryStore) BeginNotificationDelivery(ctx context.Context, record notificationdelivery.Record) (notificationdelivery.Record, bool, error) {
	stored, err := scanNotificationDelivery(s.db.QueryRowContext(ctx, `INSERT INTO rhinoq_notification_deliveries
		(id,event_id,destination_id,state,attempts,last_error,version,created_at,updated_at,sent_at,next_attempt_at,lease_owner,lease_until,message_payload)
		VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL,$8,NULL,NULL,NULLIF($9,'')::jsonb)
		ON CONFLICT (event_id,destination_id) DO UPDATE SET event_id=EXCLUDED.event_id
		RETURNING `+notificationDeliveryColumns, record.ID, record.EventID, record.DestinationID,
		record.State, record.Attempts, record.Version, record.CreatedAt, record.UpdatedAt, record.Payload))
	if err != nil {
		return notificationdelivery.Record{}, false, err
	}
	return stored, stored.ID == record.ID, nil
}

func (s *NotificationDeliveryStore) SaveNotificationDelivery(ctx context.Context, record notificationdelivery.Record, expected int64) (notificationdelivery.Record, error) {
	stored, err := scanNotificationDelivery(s.db.QueryRowContext(ctx, `UPDATE rhinoq_notification_deliveries
		SET state=$2,attempts=$3,last_error=$4,version=$5,updated_at=$6,sent_at=$7,
			next_attempt_at=$9,lease_owner=$10,lease_until=$11,message_payload=NULLIF($12,'')::jsonb
		WHERE id=$1 AND version=$8 RETURNING `+notificationDeliveryColumns,
		record.ID, record.State, record.Attempts, nullableString(record.LastError), record.Version,
		record.UpdatedAt, nullableTime(record.SentAt), expected, nullableTime(record.NextAttemptAt),
		nullableString(record.LeaseOwner), nullableTime(record.LeaseUntil), record.Payload))
	if errors.Is(err, sql.ErrNoRows) {
		return notificationdelivery.Record{}, ports.ErrVersionConflict
	}
	return stored, err
}

func (s *NotificationDeliveryStore) ClaimNotificationDelivery(ctx context.Context, owner string, now time.Time, lease time.Duration) (notificationdelivery.Record, bool, error) {
	if owner == "" || now.IsZero() || lease <= 0 {
		return notificationdelivery.Record{}, false, errors.New("notification claim requires owner, time and lease")
	}
	stored, err := scanNotificationDelivery(s.db.QueryRowContext(ctx, `
		WITH candidate AS (
			SELECT id
			FROM rhinoq_notification_deliveries
			WHERE state IN ('pending','failed')
			  AND COALESCE(next_attempt_at, updated_at) <= $2
			  AND (lease_until IS NULL OR lease_until <= $2)
			ORDER BY COALESCE(next_attempt_at, updated_at), id
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE rhinoq_notification_deliveries AS delivery
		SET state='pending',
			attempts=CASE WHEN delivery.state='failed' THEN delivery.attempts+1 ELSE delivery.attempts END,
			version=delivery.version+1, updated_at=$2,
			lease_owner=$1, lease_until=$3
		FROM candidate
		WHERE delivery.id=candidate.id
		RETURNING `+notificationDeliveryColumnsAliased, owner, now, now.Add(lease)))
	if errors.Is(err, sql.ErrNoRows) {
		return notificationdelivery.Record{}, false, nil
	}
	return stored, err == nil, err
}
