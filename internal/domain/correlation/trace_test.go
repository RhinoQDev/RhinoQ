package correlation

import (
	"errors"
	"strings"
	"testing"
)

const (
	sampleTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	sampleSpanID  = "00f067aa0ba902b7"
	sampleParent  = "00-" + sampleTraceID + "-" + sampleSpanID + "-01"
)

func TestParseTraceParentAcceptsSpecExample(t *testing.T) {
	trace, err := ParseTraceParent(sampleParent)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if trace.TraceID != sampleTraceID {
		t.Errorf("trace id = %q, want %q", trace.TraceID, sampleTraceID)
	}
	if trace.SpanID != sampleSpanID {
		t.Errorf("span id = %q, want %q", trace.SpanID, sampleSpanID)
	}
	if !trace.Sampled() {
		t.Error("flags 01 must report sampled")
	}
	if trace.Zero() {
		t.Error("a parsed context is not zero")
	}
}

func TestParseTraceParentRejectsMalformed(t *testing.T) {
	// Each case is a distinct rule in the specification. They are listed
	// together because the failure mode they share is the dangerous one: a
	// permissive parser stores an id that joins to nothing, and the operator
	// only finds out during an incident.
	cases := map[string]string{
		"empty":              "",
		"blank":              "   ",
		"too few fields":     "00-" + sampleTraceID + "-" + sampleSpanID,
		"version ff":         "ff-" + sampleTraceID + "-" + sampleSpanID + "-01",
		"version not hex":    "0g-" + sampleTraceID + "-" + sampleSpanID + "-01",
		"version one char":   "0-" + sampleTraceID + "-" + sampleSpanID + "-01",
		"all-zero trace id":  "00-" + strings.Repeat("0", 32) + "-" + sampleSpanID + "-01",
		"all-zero span id":   "00-" + sampleTraceID + "-" + strings.Repeat("0", 16) + "-01",
		"short trace id":     "00-" + sampleTraceID[:31] + "-" + sampleSpanID + "-01",
		"short span id":      "00-" + sampleTraceID + "-" + sampleSpanID[:15] + "-01",
		"uppercase trace id": "00-" + strings.ToUpper(sampleTraceID) + "-" + sampleSpanID + "-01",
		"non-hex trace id":   "00-" + strings.Repeat("z", 32) + "-" + sampleSpanID + "-01",
		"long flags":         "00-" + sampleTraceID + "-" + sampleSpanID + "-001",
		"v00 trailing junk":  sampleParent + "-extra",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseTraceParent(raw); !errors.Is(err, ErrTraceParentMalformed) {
				t.Fatalf("ParseTraceParent(%q) error = %v, want ErrTraceParentMalformed", raw, err)
			}
		})
	}
}

// A receiver that rejects an unknown version stops working the day the standard
// grows. The specification requires parsing the first four fields and ignoring
// the rest, so this is a forward-compatibility contract, not a leniency.
func TestParseTraceParentAcceptsFutureVersionWithExtraFields(t *testing.T) {
	raw := "01-" + sampleTraceID + "-" + sampleSpanID + "-01-somethingnew"
	trace, err := ParseTraceParent(raw)
	if err != nil {
		t.Fatalf("parse future version: %v", err)
	}
	if trace.TraceID != sampleTraceID || trace.SpanID != sampleSpanID {
		t.Fatalf("future version lost its ids: %+v", trace)
	}
	// It is re-rendered as version 00 because that is the only layout RhinoQ
	// can promise a downstream reader.
	if got := trace.TraceParent(); got != sampleParent {
		t.Errorf("TraceParent() = %q, want %q", got, sampleParent)
	}
}

func TestTraceParentRoundTrip(t *testing.T) {
	trace, err := ParseTraceParent(sampleParent)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := trace.TraceParent(); got != sampleParent {
		t.Fatalf("round trip = %q, want %q", got, sampleParent)
	}
}

// The zero context must not render a syntactically valid header. An all-zero
// parent is invalid per the specification, and emitting one would turn "no
// trace" into a trace id that every untraced Task shares.
func TestZeroTraceContextRendersEmpty(t *testing.T) {
	var trace TraceContext
	if !trace.Zero() {
		t.Error("zero value must report Zero()")
	}
	if got := trace.TraceParent(); got != "" {
		t.Errorf("TraceParent() = %q, want empty", got)
	}
	if trace.Sampled() {
		t.Error("zero value must not report sampled")
	}
}

func TestSampledReadsOnlyTheDefinedBit(t *testing.T) {
	cases := map[string]bool{"00": false, "01": true, "02": false, "03": true, "ff": true}
	for flags, want := range cases {
		trace := TraceContext{TraceID: sampleTraceID, SpanID: sampleSpanID, Flags: flags}
		if got := trace.Sampled(); got != want {
			t.Errorf("flags %q Sampled() = %v, want %v", flags, got, want)
		}
	}
}

// An unknown flag bit must survive storage. Canonicalising it to 00 would lose
// information RhinoQ was handed and did not need to understand.
func TestUnknownFlagBitsSurviveRoundTrip(t *testing.T) {
	raw := "00-" + sampleTraceID + "-" + sampleSpanID + "-fe"
	trace, err := ParseTraceParent(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if trace.Flags != "fe" {
		t.Fatalf("flags = %q, want fe", trace.Flags)
	}
	if got := trace.TraceParent(); got != raw {
		t.Errorf("round trip = %q, want %q", got, raw)
	}
}

func TestWithTraceStateBounds(t *testing.T) {
	trace, err := ParseTraceParent(sampleParent)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	withState, err := trace.WithTraceState("congo=t61rcWkgMzE,rojo=00f067aa0ba902b7")
	if err != nil {
		t.Fatalf("WithTraceState: %v", err)
	}
	if withState.TraceState == "" {
		t.Error("tracestate was dropped")
	}
	if _, err := trace.WithTraceState(strings.Repeat("a", MaxTraceStateBytes+1)); !errors.Is(err, ErrTraceStateBounds) {
		t.Fatalf("oversized tracestate error = %v, want ErrTraceStateBounds", err)
	}
	cleared, err := withState.WithTraceState("   ")
	if err != nil {
		t.Fatalf("clearing tracestate: %v", err)
	}
	if cleared.TraceState != "" {
		t.Errorf("blank tracestate must clear, got %q", cleared.TraceState)
	}
}

func TestNormalize(t *testing.T) {
	// A context built in code, with the flag field left unset, must normalize to
	// the same stored shape a parsed one has.
	built := TraceContext{TraceID: sampleTraceID, SpanID: sampleSpanID}
	normalized, err := built.Normalize()
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if normalized.Flags != "00" {
		t.Errorf("flags = %q, want 00", normalized.Flags)
	}

	if _, err := (TraceContext{}).Normalize(); err != nil {
		t.Errorf("zero context must normalize to zero, got %v", err)
	}

	bad := TraceContext{TraceID: "nothex", SpanID: sampleSpanID}
	if _, err := bad.Normalize(); !errors.Is(err, ErrTraceParentMalformed) {
		t.Fatalf("invalid context error = %v, want ErrTraceParentMalformed", err)
	}
}
