# Finding notifications

`SendFindingNotification` sends one Finding to either a generic JSON webhook or
a Slack incoming webhook. Generic requests carry:

```text
X-RhinoQ-Event-Id: finding_<deterministic id>
X-RhinoQ-Signature: v1=<HMAC-SHA256 body>
```

The stable event ID lets receivers deduplicate retries. RhinoQ also stores a
durable destination/event delivery record, so repeating a successful send is
reported as `deduplicated`; separate destinations are independent. Evidence is
excluded by default because it may contain business data. HTTPS is required
outside loopback tests and delivery has a bounded timeout.

```go
_, err := client.SendFindingNotification(ctx, key, rhinoq.NotificationDestination{
    URL: os.Getenv("RHINOQ_FINDING_WEBHOOK_URL"),
    Kind: "webhook", // or "slack"
    Secret: os.Getenv("RHINOQ_FINDING_WEBHOOK_SECRET"),
})
```

Set `GracePeriod` to avoid paging on short-lived drift and `FindingBaseURL` to
include a direct Workbench link. Open drift is high severity; a regression is
critical and bypasses the grace period. Delivery remains explicit and
synchronous: a multi-node scheduler for automatic fan-out is not included.
