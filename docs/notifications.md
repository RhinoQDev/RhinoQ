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
critical and bypasses the grace period.

## Reviewed routing

The shared `.rhinoq/notifications.json` registry supports additive
`minimumSeverity`, `ruleIds` and `subjectTypes` filters. Configure them from
either CLI; real routing and delivery remain Go-owned:

```bash
rhinoq notify add payments --kind slack --url-env RHINOQ_PAYMENTS_SLACK \
  --minimum-severity high --rule refund-confirmed --subject-type payment
rhinoq notify route --rule refund-confirmed --subject-type payment \
  --subject payment-42 --version 1
```

`notify route` reads the exact authoritative Finding, derives severity from the
same Application policy that builds the message, and selects every matching
destination. Each selected destination then uses the existing durable
event/destination ledger. A non-match is a successful no-op. Node can edit and
preview the registry but deliberately cannot send a real Finding.

Delivery can remain synchronous with `SendFindingNotification`, or be queued
and claimed by the durable multi-node scheduler. The scheduler uses a
PostgreSQL row lease plus `FOR UPDATE SKIP LOCKED`, persists the next attempt,
and moves a delivery to `dead` after its bounded attempt budget. It receives a
destination resolver from the application; it never stores or discovers
secrets itself:

```go
receipt, err := client.QueueFindingNotification(ctx, key, destination)
scheduler, err := client.NewNotificationScheduler(rhinoq.NotificationSchedulerOptions{
    Owner: "notify-node-1",
    Send: func(ctx context.Context, delivery rhinoq.NotificationDelivery) error {
        // Resolve DestinationID in application configuration. Payload is the
        // durable signed-message body; secrets stay outside the ledger.
        return sendConfiguredFinding(ctx, delivery)
    },
})
if err != nil { /* fail closed: this store has no durable lease */ }
go scheduler.Run(ctx)
```

The full profile must apply migration `025_notification_scheduler.sql` before
starting a scheduler. Task-only profiles do not include this delivery ledger.

`QueueFindingNotification` is the durable handoff; it stores the signed-message
payload but does not contact the receiver. A sender error is recorded before the scheduler returns, so another
node can claim the work after the backoff. A `dead` row is an operator decision,
not an invitation to retry blindly. Because the payload is durable, opt-in
evidence may contain business data; protect the table and apply the same
retention policy as the receiver-facing message.
## Notification delivery boundary

The Node sender supports a bounded same-process transport retry with
`maxAttempts` (1–5) and linear `backoffMs`. Every attempt carries the same
`x-rhinoq-event-id`, so a conforming receiver can deduplicate it. Only HTTP 429
and 5xx responses are retried; authentication and other 4xx failures stop.

This is not a durable scheduler. The Go delivery ledger remains authoritative
for persisted delivery state, retry scheduling and cross-process
deduplication. A Node process crash can still lose an in-process retry.

## Task verification email and webhook delivery

The PostgreSQL Task profile has a separate durable `notification_outbox` for
business-verification mismatches. Node applications can drain it without
reimplementing lease or retry correctness:

```ts
const delivery = createTaskWebhookDelivery({
  destination: resolvedDestination,
  severity: (record) => severityPolicy(record.finding),
});

await new TaskNotificationWorker({
  queue: app.tasks,
  delivery,
  owner: `notify-${process.env.HOSTNAME}`,
}).run(shutdownSignal);
```

`createTaskEmailDelivery` is provider-neutral. The application supplies
`recipients`, `render` and `send`; the adapter passes the durable notification
ID as `idempotencyKey`. This keeps tenant routing, addresses, templates and
mail-provider credentials out of RhinoQ:

```ts
const email = createTaskEmailDelivery({
  recipients: (record) => supportRecipients(record.finding),
  render: (record) => ({
    subject: `Task ${record.taskId} needs review`,
    text: record.verification.summary ?? 'Open the Task link to review evidence.',
  }),
  send: (message) => mailProvider.send(message),
});
```

The worker claims one row at a time. Success completes the leased row; failure
records a bounded error and schedules the next claim through the store. It does
not guess severity or recipients, send inline with Task correctness, or expose
notification state to the owner browser API.
