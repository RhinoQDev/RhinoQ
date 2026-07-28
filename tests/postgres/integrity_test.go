package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	domaineffect "github.com/rhinoq/rhinoq/internal/domain/effect"
	"github.com/rhinoq/rhinoq/internal/runtime/lease"
	"github.com/rhinoq/rhinoq/pkg/rhinoq"
)

// Opening an effect is the last place a duplicate charge can be stopped, so the
// fence has to live in the INSERT itself.
func TestEffectLedgerIsFencedInSQL(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	enqueue(t, client, rhinoq.JobRequest{Name: "charge-card", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-1")

	request := rhinoq.EffectRequest{Name: "charge", Key: "charge:1", Irreversible: true}
	opened, err := client.BeginEffect(ctx, leased.Lease, request)
	if err != nil {
		t.Fatalf("the live execution must be able to open its effect: %v", err)
	}
	if opened.State != rhinoq.EffectPending {
		t.Fatalf("a freshly opened effect is pending: %+v", opened)
	}

	// The lease dies, the job is handed on, and the old execution comes back.
	expireLeases(t)
	sweep(t, client)
	next := claimOne(t, client, "worker-2")
	if next.Lease.Epoch <= leased.Lease.Epoch {
		t.Fatalf("the claim must advance the epoch: %+v", next.Lease)
	}

	if _, err := client.BeginEffect(ctx, leased.Lease, rhinoq.EffectRequest{
		Name: "charge", Key: "charge:2", Irreversible: true,
	}); !errors.Is(err, rhinoq.ErrLeaseLost) {
		t.Fatalf("a stale execution must not open a second charge, got %v", err)
	}
	if _, err := client.ResolveEffect(ctx, leased.Lease, request, "provider-ref", rhinoq.EffectSucceeded); !errors.Is(err, rhinoq.ErrLeaseLost) {
		t.Fatalf("a stale execution must not confirm an effect, got %v", err)
	}
}

// An effect that was in flight when its worker died has an unknown result. The
// sweep must say so instead of leaving it pending for the next attempt to redo.
func TestAbandonedEffectBecomesUncertain(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	enqueue(t, client, rhinoq.JobRequest{Name: "payout", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-1")
	request := rhinoq.EffectRequest{Name: "payout", Key: "payout:1", Irreversible: true}
	if _, err := client.BeginEffect(ctx, leased.Lease, request); err != nil {
		t.Fatal(err)
	}

	expireLeases(t)
	sweep(t, client)

	effects := newEffectStore(t)
	stored, found, err := effects.GetEffect(ctx, leased.Lease.JobID, "payout", "payout:1")
	if err != nil || !found {
		t.Fatalf("read effect: found=%v err=%v", found, err)
	}
	if stored.State != domaineffect.Uncertain {
		t.Fatalf("an abandoned effect must be downgraded to uncertain, got %s", stored.State)
	}

	// The next execution's own effect must not be swept by a later pass.
	next := claimOne(t, client, "worker-2")
	fresh := rhinoq.EffectRequest{Name: "refund", Key: "refund:1", Irreversible: true}
	if _, err := client.BeginEffect(ctx, next.Lease, fresh); err != nil {
		t.Fatal(err)
	}
	sweep(t, client)
	live, found, err := effects.GetEffect(ctx, next.Lease.JobID, "refund", "refund:1")
	if err != nil || !found || live.State != domaineffect.Pending {
		t.Fatalf("a live execution's effect must be left alone: %+v found=%v err=%v", live, found, err)
	}
}

// An uncertain effect is exactly the case where replaying would charge twice.
func TestReplayIsRefusedWhileAnEffectIsUncertain(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	id := enqueue(t, client, rhinoq.JobRequest{Name: "settle", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-1")
	if _, err := client.BeginEffect(ctx, leased.Lease, rhinoq.EffectRequest{
		Name: "settle", Key: "settle:1", Irreversible: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.FailJob(ctx, leased.Lease, rhinoq.FailureReport{
		RetryClass: rhinoq.RetryPermanent, Message: "provider rejected",
	}); err != nil {
		t.Fatal(err)
	}
	// Mark the effect uncertain the way the sweep would.
	expireLeases(t)
	sweep(t, client)

	if _, _, err := client.ReplayJob(ctx, id, "ops@example.com", "retry after provider recovered"); !errors.Is(err, rhinoq.ErrReplayUnresolvedEffect) && !errors.Is(err, rhinoq.ErrReplayUncertainEffect) {
		t.Fatalf("replay must be refused while the effect is unresolved, got %v", err)
	}

	items, err := client.ListAttention(ctx, "settle", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	var sawEffect bool
	for _, item := range items {
		if item.Kind == rhinoq.AttentionEffectUncertain {
			sawEffect = true
		}
	}
	if !sawEffect {
		t.Fatalf("an unresolved effect must show up in Needs Attention: %+v", items)
	}
}

// Replaying a dead job has to be recorded, and the audit rows have to chain.
func TestGuardedReplayWritesAChainedAudit(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()
	id := enqueue(t, client, rhinoq.JobRequest{Name: "report", Payload: []byte("{}")})
	leased := claimOne(t, client, "worker-1")
	if _, err := client.FailJob(ctx, leased.Lease, rhinoq.FailureReport{
		RetryClass: rhinoq.RetryPermanent, Message: "bad input",
	}); err != nil {
		t.Fatal(err)
	}

	replayed, first, err := client.ReplayJob(ctx, id, "ops@example.com", "input fixed")
	if err != nil {
		t.Fatalf("a dead job with no effects must be replayable: %v", err)
	}
	if replayed.State != "pending" || replayed.Attempts != 1 {
		t.Fatalf("replay returns the job to pending and keeps its evidence: %+v", replayed)
	}
	if first.PrevHash != "" || first.RowHash == "" {
		t.Fatalf("the first audit row starts the chain: %+v", first)
	}

	second := claimOne(t, client, "worker-1")
	if _, err := client.FailJob(ctx, second.Lease, rhinoq.FailureReport{
		RetryClass: rhinoq.RetryPermanent, Message: "bad input again",
	}); err != nil {
		t.Fatal(err)
	}
	_, next, err := client.ReplayJob(ctx, id, "ops@example.com", "second decision")
	if err != nil {
		t.Fatal(err)
	}
	if next.PrevHash != first.RowHash {
		t.Fatalf("audit rows must chain: %s != %s", next.PrevHash, first.RowHash)
	}
	trail, err := client.AuditTrail(ctx, id, 0, 10)
	if err != nil || len(trail) != 2 || trail[0].RowHash != next.RowHash {
		t.Fatalf("the trail must be newest first: %+v err=%v", trail, err)
	}
}

// The SQL function is what lets a language without an SDK enqueue safely.
func TestSQLEnqueueValidatesItsCaller(t *testing.T) {
	client := newClient(t)
	ctx := context.Background()

	// A job that is not registered cannot be created at all.
	var id string
	err := testDB.QueryRow(`SELECT rhinoq.enqueue('unregistered', '{}'::jsonb)`).Scan(&id)
	if err == nil {
		t.Fatal("an unregistered job name must be refused")
	}
	if !strings.Contains(err.Error(), "RHINOQ_JOB_NOT_ALLOWED") {
		t.Fatalf("expected a typed refusal, got %v", err)
	}

	if _, err := testDB.Exec(`
		INSERT INTO rhinoq.job_allowlist (job_name, max_payload_bytes, default_priority, default_class)
		VALUES ('settle-scan-credit', 64, 7, 'critical')`); err != nil {
		t.Fatal(err)
	}

	if err := testDB.QueryRow(`
		SELECT rhinoq.enqueue(
			job_name        => 'settle-scan-credit',
			payload         => '{"scanId":"SCAN-1"}'::jsonb,
			idempotency_key => 'scan:SCAN-1',
			correlation_id  => 'SCAN-1')`).Scan(&id); err != nil {
		t.Fatalf("a registered job must be enqueued: %v", err)
	}
	state := jobState(t, client, "settle-scan-credit", id)
	if state.Priority != 7 || state.Class != rhinoq.ClassCritical || state.CorrelationID != "SCAN-1" {
		t.Fatalf("the allowlist defaults must be applied: %+v", state)
	}

	// The same key returns the same job: the function goes through the same
	// idempotency constraint as the Go client.
	var repeat string
	if err := testDB.QueryRow(`
		SELECT rhinoq.enqueue('settle-scan-credit', '{"scanId":"SCAN-1"}'::jsonb, 'scan:SCAN-1')`).Scan(&repeat); err != nil {
		t.Fatal(err)
	}
	if repeat != id {
		t.Fatalf("a repeated idempotency key must return the first job: %s vs %s", repeat, id)
	}

	// An oversized payload is refused before it reaches the table.
	err = testDB.QueryRow(`
		SELECT rhinoq.enqueue('settle-scan-credit',
			jsonb_build_object('blob', repeat('x', 200)), 'scan:SCAN-2')`).Scan(&id)
	if err == nil || !strings.Contains(err.Error(), "RHINOQ_PAYLOAD_TOO_LARGE") {
		t.Fatalf("an oversized payload must be refused, got %v", err)
	}
	counts, err := client.JobCounts(ctx, "settle-scan-credit")
	if err != nil {
		t.Fatal(err)
	}
	if counts["pending"] != 1 {
		t.Fatalf("the refused payload must not have been stored: %+v", counts)
	}

	// A job the SQL function created is ordinary work: a worker claims it.
	claimed := claimOne(t, client, "worker-1")
	if claimed.Job.Name != "settle-scan-credit" {
		t.Fatalf("expected the SQL-enqueued job, got %+v", claimed.Job)
	}
}

func TestSQLEnqueueAuthorizesTheInvokingLogin(t *testing.T) {
	_ = newClient(t)
	ctx := context.Background()

	const allowedRole = "rhinoq_test_producer_allowed"
	const deniedRole = "rhinoq_test_producer_denied"
	t.Cleanup(func() {
		_, _ = testDB.Exec(`
			REVOKE ALL ON FUNCTION rhinoq.enqueue(
				text, jsonb, text, text, integer, text, interval, text
			) FROM ` + deniedRole)
		_, _ = testDB.Exec(`REVOKE USAGE ON SCHEMA rhinoq FROM ` + deniedRole)
		_, _ = testDB.Exec(`
			REVOKE ALL ON FUNCTION rhinoq.enqueue(
				text, jsonb, text, text, integer, text, interval, text
			) FROM ` + allowedRole)
		_, _ = testDB.Exec(`REVOKE USAGE ON SCHEMA rhinoq FROM ` + allowedRole)
		_, _ = testDB.Exec(`DROP ROLE IF EXISTS ` + deniedRole)
		_, _ = testDB.Exec(`DROP ROLE IF EXISTS ` + allowedRole)
	})
	for _, role := range []string{allowedRole, deniedRole} {
		if _, err := testDB.Exec(`DROP ROLE IF EXISTS ` + role); err != nil {
			t.Skipf("producer-role contract requires a disposable database role with CREATEROLE: %v", err)
		}
		if _, err := testDB.Exec(`CREATE ROLE ` + role + ` NOLOGIN`); err != nil {
			t.Skipf("producer-role contract requires a disposable database role with CREATEROLE: %v", err)
		}
	}
	if _, err := testDB.Exec(`
		GRANT USAGE ON SCHEMA rhinoq
		TO ` + allowedRole + `, ` + deniedRole); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Exec(`
		GRANT EXECUTE ON FUNCTION rhinoq.enqueue(
			text, jsonb, text, text, integer, text, interval, text
		) TO ` + allowedRole + `, ` + deniedRole); err != nil {
		t.Fatal(err)
	}

	if _, err := testDB.Exec(`
		INSERT INTO rhinoq.job_allowlist (
			job_name, producer_role, max_payload_bytes
		) VALUES ('restricted-report', $1, 1024)`, allowedRole); err != nil {
		t.Fatal(err)
	}

	conn, err := testDB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	defer func() {
		_, _ = conn.ExecContext(context.Background(), `RESET SESSION AUTHORIZATION`)
	}()

	if _, err := conn.ExecContext(ctx, `SET SESSION AUTHORIZATION `+deniedRole); err != nil {
		t.Skipf("test connection cannot change session authorization: %v", err)
	}
	var id string
	err = conn.QueryRowContext(ctx, `
		SELECT rhinoq.enqueue(
			'restricted-report',
			'{"reportId":"report_denied"}'::jsonb
		)`).Scan(&id)
	if err == nil || !strings.Contains(err.Error(), "RHINOQ_JOB_FORBIDDEN") {
		t.Fatalf("a login outside producer_role must be refused, got id=%q err=%v", id, err)
	}

	if _, err := conn.ExecContext(ctx, `RESET SESSION AUTHORIZATION`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `SET SESSION AUTHORIZATION `+allowedRole); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRowContext(ctx, `
		SELECT rhinoq.enqueue(
			'restricted-report',
			'{"reportId":"report_allowed"}'::jsonb
		)`).Scan(&id); err != nil {
		t.Fatalf("the authorized login must be able to enqueue: %v", err)
	}
	if !strings.HasPrefix(id, "job_") {
		t.Fatalf("expected a durable job id, got %q", id)
	}
	if _, err := conn.ExecContext(ctx, `RESET SESSION AUTHORIZATION`); err != nil {
		t.Fatal(err)
	}
}

func sweep(t *testing.T, _ *rhinoq.Client) {
	t.Helper()
	reaper, err := lease.NewReaper(lease.Config{
		Store: mustStore(t), Effects: newEffectStore(t), Interval: time.Hour,
		Now: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reaper.Sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
}
