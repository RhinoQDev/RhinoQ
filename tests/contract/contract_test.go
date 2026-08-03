// Package contract holds the cross-language wire tests.
//
// RhinoQ ships two implementations of one contract: the Go types in pkg/rhinoq
// and the TypeScript client in sdks/node. Nothing in a Go unit test notices
// when the Node mock drifts, and nothing in a Node test notices when a Go
// field is renamed — each side stays internally consistent while they stop
// agreeing with each other.
//
// The binding is a golden file per contract in testdata/contracts. Go produces
// it and asserts byte equality; Node consumes the same bytes as its transport
// fixture. A field that changes on one side and not the other fails here rather
// than in an adopter's application.
package contract

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the contract test")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
}

func goldenPath(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(repositoryRoot(t), "testdata", "contracts", name)
}

// assertGolden compares produced wire bytes with the committed fixture. The
// failure names the file both languages read, because updating one side and
// regenerating the golden is the whole mistake this catches.
func assertGolden(t *testing.T, name string, actual []byte) {
	t.Helper()
	path := goldenPath(t, name)
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the golden contract: %v", err)
	}
	if bytes.Equal(actual, expected) {
		return
	}
	t.Fatalf(
		"wire contract drifted from %s.\n"+
			"The Node SDK reads this same file as its transport fixture, so changing "+
			"one side alone breaks the other silently. Bump the schema version and "+
			"update both SDKs before regenerating it.\n\nproduced:\n%s",
		path, actual,
	)
}
