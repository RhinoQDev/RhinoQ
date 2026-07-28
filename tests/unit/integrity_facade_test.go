package unit

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// The facade's promise is negative: it must not expose anything that starts or
// touches the runtime plane. Asserting on the method set is how that promise
// stays true as the package grows, because a stray method added to
// IntegrityClient is exactly how a queue would leak back into it.
func TestIntegrityClientExposesNoRuntimeSurface(t *testing.T) {
	forbidden := []string{
		"Enqueue", "Handle", "Run", "ClaimJobs", "CompleteJob", "FailJob",
		"Heartbeat", "ReleaseJob", "Cancel", "Replay", "ListJobs", "JobCounts",
		"PauseQueue", "ResumeQueue", "SetQueueRateLimit", "SetQueueAdmission",
		"RecordEffect", "ConfirmEffect", "RecordOutcome", "ListAttention",
	}
	methods := methodNames(reflect.TypeOf(&rhinoq.IntegrityClient{}))
	for _, name := range forbidden {
		if methods[name] {
			t.Errorf(
				"IntegrityClient must not expose %s: the integrity plane exists so a"+
					" team can verify business state without adopting a queue", name)
		}
	}
}

func TestIntegrityClientExposesTheVerificationSurface(t *testing.T) {
	required := []string{
		"RegisterRule", "ListRules", "ExplainRule", "EnableRule", "DisableRule",
		"Scan", "ListFindings", "FindingHistory", "TransitionFinding", "RunScheduler",
	}
	methods := methodNames(reflect.TypeOf(&rhinoq.IntegrityClient{}))
	for _, name := range required {
		if !methods[name] {
			t.Errorf("IntegrityClient is missing %s", name)
		}
	}
}

// The full Client keeps the whole surface, so adopting the runtime later is not
// a rewrite: the Rules and Findings registered through the facade are the same
// records.
func TestClientStillCarriesTheIntegritySurface(t *testing.T) {
	methods := methodNames(reflect.TypeOf(&rhinoq.Client{}))
	for _, name := range []string{"RegisterRule", "ListFindings", "Scan", "Enqueue", "Handle"} {
		if !methods[name] {
			t.Errorf("Client must still expose %s", name)
		}
	}
}

func TestScanRefusesASubjectAndACursorTogether(t *testing.T) {
	integrity := rhinoq.NewInMemoryIntegrity()
	_, err := integrity.Scan(context.Background(), rhinoq.ScanRequest{
		RuleID: "any", SubjectID: "report_1", Cursor: "report_0",
	})
	if err == nil || !strings.Contains(err.Error(), "either a subject or a cursor") {
		t.Fatalf("asking about one record and resuming a walk are different requests: %v", err)
	}
}

func TestScanRefusesAnUnboundedPageBudget(t *testing.T) {
	integrity := rhinoq.NewInMemoryIntegrity()
	_, err := integrity.Scan(context.Background(), rhinoq.ScanRequest{
		RuleID: "any", MaxPages: rhinoq.MaxScanPages + 1,
	})
	if err == nil || !strings.Contains(err.Error(), "page budget") {
		t.Fatalf("a mistyped budget must not become an unbounded scan: %v", err)
	}
}

func TestScanRequiresARuleID(t *testing.T) {
	integrity := rhinoq.NewInMemoryIntegrity()
	if _, err := integrity.Scan(context.Background(), rhinoq.ScanRequest{}); err == nil {
		t.Fatal("a scan without a rule has nothing to verify")
	}
}

func methodNames(t reflect.Type) map[string]bool {
	names := make(map[string]bool, t.NumMethod())
	for index := 0; index < t.NumMethod(); index++ {
		names[t.Method(index).Name] = true
	}
	return names
}
