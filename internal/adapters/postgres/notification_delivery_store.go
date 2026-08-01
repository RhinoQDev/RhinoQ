package postgres

import (
	"context"
	"database/sql"
	"errors"

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
	COALESCE(last_error,''),version,created_at,updated_at,sent_at`

func scanNotificationDelivery(row rowScanner) (notificationdelivery.Record, error) {
	var record notificationdelivery.Record
	var sent sql.NullTime
	err := row.Scan(&record.ID, &record.EventID, &record.DestinationID, &record.State,
		&record.Attempts, &record.LastError, &record.Version, &record.CreatedAt, &record.UpdatedAt, &sent)
	if sent.Valid {
		record.SentAt = sent.Time
	}
	return record, err
}

func (s *NotificationDeliveryStore) BeginNotificationDelivery(ctx context.Context, record notificationdelivery.Record) (notificationdelivery.Record, bool, error) {
	stored, err := scanNotificationDelivery(s.db.QueryRowContext(ctx, `INSERT INTO rhinoq_notification_deliveries
		(id,event_id,destination_id,state,attempts,last_error,version,created_at,updated_at,sent_at)
		VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL)
		ON CONFLICT (event_id,destination_id) DO UPDATE SET event_id=EXCLUDED.event_id
		RETURNING `+notificationDeliveryColumns, record.ID, record.EventID, record.DestinationID,
		record.State, record.Attempts, record.Version, record.CreatedAt, record.UpdatedAt))
	if err != nil {
		return notificationdelivery.Record{}, false, err
	}
	return stored, stored.ID == record.ID, nil
}

func (s *NotificationDeliveryStore) SaveNotificationDelivery(ctx context.Context, record notificationdelivery.Record, expected int64) (notificationdelivery.Record, error) {
	stored, err := scanNotificationDelivery(s.db.QueryRowContext(ctx, `UPDATE rhinoq_notification_deliveries
		SET state=$2,attempts=$3,last_error=$4,version=$5,updated_at=$6,sent_at=$7
		WHERE id=$1 AND version=$8 RETURNING `+notificationDeliveryColumns,
		record.ID, record.State, record.Attempts, nullableString(record.LastError), record.Version,
		record.UpdatedAt, nullableTime(record.SentAt), expected))
	if errors.Is(err, sql.ErrNoRows) {
		return notificationdelivery.Record{}, ports.ErrVersionConflict
	}
	return stored, err
}
