package ports

import (
	"context"
	notificationcontract "github.com/madebyduy/RhinoQ/internal/contracts/notification"
	"github.com/madebyduy/RhinoQ/internal/domain/notificationdelivery"
)

type NotificationSender interface {
	Send(context.Context, notificationcontract.Message) error
}

type NotificationDeliveryStore interface {
	BeginNotificationDelivery(context.Context, notificationdelivery.Record) (notificationdelivery.Record, bool, error)
	SaveNotificationDelivery(context.Context, notificationdelivery.Record, int64) (notificationdelivery.Record, error)
}
