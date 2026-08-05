package ports

import (
	"context"
	notificationcontract "github.com/madebyduy/RhinoQ/internal/contracts/notification"
	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
	"time"
)

type NotificationSender interface {
	Send(context.Context, notificationcontract.Message) error
}

type NotificationDeliveryStore interface {
	BeginNotificationDelivery(context.Context, notificationdelivery.Record) (notificationdelivery.Record, bool, error)
	SaveNotificationDelivery(context.Context, notificationdelivery.Record, int64) (notificationdelivery.Record, error)
}

// NotificationDeliveryLeaseStore is the optional durable scheduler surface.
// Keeping it separate preserves compatibility for applications that only use
// synchronous delivery.
type NotificationDeliveryLeaseStore interface {
	NotificationDeliveryStore
	ClaimNotificationDelivery(context.Context, string, time.Time, time.Duration) (notificationdelivery.Record, bool, error)
}
