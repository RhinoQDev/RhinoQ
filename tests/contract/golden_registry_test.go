package contract

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A golden file only binds two implementations while both actually read it.
// A fixture that just one side loads is not a contract — it is a mock with a
// convincing filename, and the other language is free to drift away from it.
//
// This walks testdata/contracts and requires every fixture to appear in a Go
// test under tests/contract and in a Node test under sdks/node/test.
func TestEveryGoldenIsReadByBothLanguages(t *testing.T) {
	t.Parallel()
	root := repositoryRoot(t)
	goSources := concatenatedSources(t, filepath.Join(root, "tests", "contract"), ".go")
	nodeSources := concatenatedSources(t, filepath.Join(root, "sdks", "node", "test"), ".mjs", ".cjs")

	entries, err := os.ReadDir(filepath.Join(root, "testdata", "contracts"))
	if err != nil {
		t.Fatalf("cannot read testdata/contracts: %v", err)
	}
	found := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		found++
		if !strings.Contains(goSources, entry.Name()) {
			t.Errorf(
				"%s is not read by any test in tests/contract. Either the Go side "+
					"stopped producing this contract, or the fixture is a Node-only mock "+
					"that nothing holds Go to.",
				entry.Name(),
			)
		}
		if !strings.Contains(nodeSources, entry.Name()) {
			t.Errorf(
				"%s is not read by any test in sdks/node/test. A golden only binds the "+
					"two implementations while both consume it.",
				entry.Name(),
			)
		}
	}
	if found == 0 {
		t.Fatal("testdata/contracts holds no fixtures; the cross-language binding is gone")
	}
}

func concatenatedSources(t *testing.T, directory string, extensions ...string) string {
	t.Helper()
	var builder strings.Builder
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		matches := false
		for _, extension := range extensions {
			if strings.HasSuffix(entry.Name(), extension) {
				matches = true
				break
			}
		}
		if !matches {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		builder.Write(content)
		return nil
	})
	if err != nil {
		t.Fatalf("cannot read %s: %v", directory, err)
	}
	return builder.String()
}
