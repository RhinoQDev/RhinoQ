package finding

import (
	"errors"
	"testing"
	"time"
)

var (
	at    = time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	later = at.Add(time.Hour)
)

func testKey() Key {
	return Key{
		RuleID: "paid-booking-is-confirmed", SubjectType: "booking",
		SubjectID: "bk_00038501", ObservedInvariantVersion: 1,
	}
}

func observation(evidence string, observedAt time.Time) Observation {
	return Observation{Key: testKey(), Evidence: evidence, ObservedAt: observedAt}
}

func TestFirstObservationOpensAFinding(t *testing.T) {
	record, err := Apply(Record{}, false, observation(`{"paid":false}`, at))
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != Open || record.OccurrenceCount != 1 ||
		!record.FirstSeen.Equal(at) || !record.LastSeen.Equal(at) {
		t.Fatalf("a first observation opens one finding seen once: %+v", record)
	}
}

func TestSeeingTheSameDriftAgainOnlyCounts(t *testing.T) {
	first, err := Apply(Record{}, false, observation(`{"paid":false}`, at))
	if err != nil {
		t.Fatal(err)
	}
	second, err := Apply(first, true, observation(`{"paid":false,"amount":5000}`, later))
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != Open || second.OccurrenceCount != 2 {
		t.Fatalf("a repeat observation counts rather than reopens: %+v", second)
	}
	if !second.FirstSeen.Equal(at) || !second.LastSeen.Equal(later) {
		t.Fatalf("first seen must not move, last seen must: %+v", second)
	}
	if second.LatestEvidence != `{"paid":false,"amount":5000}` {
		t.Fatalf("the newest evidence wins: %q", second.LatestEvidence)
	}
}

// Empty evidence must not erase what the last observation proved. An operator
// reading a Finding whose evidence vanished cannot tell drift from a bug here.
func TestEmptyEvidenceDoesNotOverwriteWhatWasProven(t *testing.T) {
	first, err := Apply(Record{}, false, observation(`{"paid":false}`, at))
	if err != nil {
		t.Fatal(err)
	}
	second, err := Apply(first, true, observation("", later))
	if err != nil {
		t.Fatal(err)
	}
	if second.LatestEvidence != `{"paid":false}` {
		t.Fatalf("evidence must survive an observation that carried none: %q", second.LatestEvidence)
	}
}

// The case the whole model exists for: a repair that did not fix the cause.
func TestDriftReturningAfterResolutionRegresses(t *testing.T) {
	resolved := Record{
		Key: testKey(), Status: Resolved, OccurrenceCount: 4,
		FirstSeen: at, LastSeen: at, ResolvedAt: at,
		Actor: "operator@example.com", Reason: "refunded by hand",
	}
	regressed, err := Apply(resolved, true, observation(`{"paid":false}`, later))
	if err != nil {
		t.Fatal(err)
	}
	if regressed.Status != Regressed {
		t.Fatalf("a resolved finding that comes back must regress, not reopen: %+v", regressed)
	}
	if !regressed.ResolvedAt.IsZero() {
		t.Fatal("a regressed finding is not resolved any more")
	}
	if regressed.Actor != "" {
		t.Fatalf("the operator who resolved it did not cause the regression: %q", regressed.Actor)
	}
}

func TestExpiredSuppressionReopens(t *testing.T) {
	ignored := Record{
		Key: testKey(), Status: Ignored, OccurrenceCount: 2,
		FirstSeen: at, LastSeen: at, SuppressedUntil: at.Add(30 * time.Minute),
	}
	reopened, err := Apply(ignored, true, observation(`{"paid":false}`, later))
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Status != Open || !reopened.SuppressedUntil.IsZero() {
		t.Fatalf("an expired suppression reopens: %+v", reopened)
	}
}

func TestLiveSuppressionStaysSuppressed(t *testing.T) {
	ignored := Record{
		Key: testKey(), Status: Ignored, OccurrenceCount: 2,
		FirstSeen: at, LastSeen: at, SuppressedUntil: later.Add(time.Hour),
	}
	still, err := Apply(ignored, true, observation(`{"paid":false}`, later))
	if err != nil {
		t.Fatal(err)
	}
	if still.Status != Ignored {
		t.Fatalf("a live suppression must hold: %+v", still)
	}
	if still.OccurrenceCount != 3 {
		t.Fatalf("a suppressed finding is still counted: %+v", still)
	}
}

// This is the property the batched evaluation depends on: a pass against a
// subject with no Finding changes nothing, so the caller can skip the write
// entirely once it knows no Finding exists.
func TestPassWithoutAFindingChangesNothing(t *testing.T) {
	record, changed, err := ApplyPass(Record{}, false, testKey(), at)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatalf("a pass with no finding must report no change: %+v", record)
	}
}

func TestPassResolvesAnOpenFinding(t *testing.T) {
	open := Record{Key: testKey(), Status: Open, OccurrenceCount: 2, FirstSeen: at}
	resolved, changed, err := ApplyPass(open, true, testKey(), later)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || resolved.Status != Resolved || !resolved.ResolvedAt.Equal(later) {
		t.Fatalf("a pass resolves an open finding: %+v changed=%v", resolved, changed)
	}
	if resolved.Actor != "rhinoq:rule" {
		t.Fatalf("the resolver must be attributed to the rule, not a person: %q", resolved.Actor)
	}
}

func TestPassOnAnAlreadyResolvedFindingIsIdempotent(t *testing.T) {
	resolved := Record{Key: testKey(), Status: Resolved, ResolvedAt: at}
	_, changed, err := ApplyPass(resolved, true, testKey(), later)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("re-resolving a resolved finding must not count as a change")
	}
}

func TestPassRequiresAValidKeyAndTime(t *testing.T) {
	if _, _, err := ApplyPass(Record{}, false, Key{}, at); err == nil {
		t.Fatal("an invalid key must be refused")
	}
	if _, _, err := ApplyPass(Record{}, false, testKey(), time.Time{}); !errors.Is(err, ErrObservationTime) {
		t.Fatalf("a zero observation time must be refused, got %v", err)
	}
}

// Regression is evidence, not an opinion. Letting an operator declare it would
// make the one status that means "the repair failed" unreliable.
func TestOperatorCannotDeclareRegression(t *testing.T) {
	open := Record{Key: testKey(), Status: Open}
	_, err := ApplyTransition(open, Transition{
		Status: Regressed, Actor: "operator@example.com", At: at,
	})
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("regressed must not be settable by hand, got %v", err)
	}
}

func TestSuppressionRequiresAnExpiryInTheFuture(t *testing.T) {
	open := Record{Key: testKey(), Status: Open}
	for name, transition := range map[string]Transition{
		"no expiry": {Status: Ignored, Actor: "ops", Reason: "accepted", At: at},
		"expiry in the past": {
			Status: Ignored, Actor: "ops", Reason: "accepted",
			At: at, Until: at.Add(-time.Minute),
		},
	} {
		if _, err := ApplyTransition(open, transition); err == nil {
			t.Fatalf("%s must be refused: a suppression that never expires is a deletion", name)
		}
	}
}

func TestSuppressingAndResolvingRequireAReason(t *testing.T) {
	open := Record{Key: testKey(), Status: Open}
	for _, status := range []Status{Ignored, FalsePositive, Resolved} {
		transition := Transition{Status: status, Actor: "ops", At: at, Until: later}
		if _, err := ApplyTransition(open, transition); !errors.Is(err, ErrReasonRequired) {
			t.Fatalf("%s must carry a reason, got %v", status, err)
		}
	}
}

func TestTransitionRequiresAnActor(t *testing.T) {
	open := Record{Key: testKey(), Status: Open}
	if _, err := ApplyTransition(open, Transition{
		Status: Acknowledged, Actor: "   ", At: at,
	}); !errors.Is(err, ErrActorRequired) {
		t.Fatalf("an anonymous decision must be refused, got %v", err)
	}
}

func TestResolvedFindingCanOnlyBeAcknowledged(t *testing.T) {
	if CanTransition(Resolved, Ignored) || CanTransition(Resolved, Open) {
		t.Fatal("a resolved finding is reopened by observation, not by an operator")
	}
	if !CanTransition(Resolved, Acknowledged) {
		t.Fatal("acknowledging a resolved finding must stay possible")
	}
}

func TestKeyValidationRejectsIncompleteIdentity(t *testing.T) {
	full := testKey()
	for name, mutate := range map[string]func(Key) Key{
		"no rule":          func(k Key) Key { k.RuleID = " "; return k },
		"no type":          func(k Key) Key { k.SubjectType = ""; return k },
		"no subject":       func(k Key) Key { k.SubjectID = ""; return k },
		"negative version": func(k Key) Key { k.ObservedInvariantVersion = -1; return k },
	} {
		if err := mutate(full).Validate(); err == nil {
			t.Fatalf("%s must be refused: a finding without full identity cannot be found again", name)
		}
	}
	if err := full.Validate(); err != nil {
		t.Fatalf("a complete key must validate: %v", err)
	}
}

// Version 0 is deliberately allowed, unlike subjectoutcome.Key which requires
// version >= 1. `rhinoq notify test` builds a synthetic Finding at version 0 to
// prove a destination's signature and TLS without writing anything, and a real
// Rule version always starts at 1, so nothing persisted can collide with it.
func TestVersionZeroIsReservedForTheSyntheticProbe(t *testing.T) {
	probe := testKey()
	probe.ObservedInvariantVersion = 0
	if err := probe.Validate(); err != nil {
		t.Fatalf("the notify probe key must remain valid: %v", err)
	}
	if probe.String() != "paid-booking-is-confirmed/booking/bk_00038501@v0" {
		t.Fatalf("the probe must be recognisable in a delivery log: %q", probe.String())
	}
}
