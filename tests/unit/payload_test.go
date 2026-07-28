package unit

import (
	"errors"
	"testing"

	"github.com/madebyduy/RhinoQ/internal/domain/job"
)

func TestPayloadLimit(t *testing.T) {
	if err := job.ValidatePayload([]byte("1234"), 4); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(job.ValidatePayload([]byte("12345"), 4), job.ErrPayloadTooLarge) {
		t.Fatal("expected payload size error")
	}
	if !errors.Is(job.ValidatePayload(nil, 4), job.ErrNilPayload) {
		t.Fatal("expected nil payload error")
	}
}
