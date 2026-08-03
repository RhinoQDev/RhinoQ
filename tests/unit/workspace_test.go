package unit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The engine's fencing, lease, integrity and recovery contracts live in
// tests/postgres, which is a separate module. Before go.work existed, `go test
// ./...` at the repository root reported PASS without compiling a single one of
// them, so a developer's local loop said "everything ran" while fourteen files
// of the most safety-critical evidence sat untouched. CI ran them in its own
// job, which is why nothing caught it.
//
// These tests fail when a module is added without being wired into both the
// workspace and the default test target, so the same gap cannot reopen quietly.

func TestEveryModuleIsInTheWorkspace(t *testing.T) {
	root := repositoryRoot(t)
	declared := workspaceModules(t, root)

	for _, module := range repositoryModules(t, root) {
		if module == "." {
			continue
		}
		if !declared[module] {
			t.Fatalf(
				"module %s is not in go.work; `go test ./...` at the repository root "+
					"would silently skip it. Add it to the use block.",
				module,
			)
		}
	}
}

func TestDefaultTestTargetCoversEveryModule(t *testing.T) {
	root := repositoryRoot(t)
	target := makefileTarget(t, root, "test")

	for _, module := range repositoryModules(t, root) {
		if module == "." {
			continue
		}
		pattern := strings.TrimPrefix(module, "./") + "/..."
		if !strings.Contains(target, pattern) {
			t.Fatalf(
				"`make test` does not run %s. A module the default target skips is a "+
					"module nobody runs locally; add %s to the test target.",
				module, pattern,
			)
		}
	}
}

// repositoryModules returns every directory holding a go.mod, relative to the
// repository root and slash-separated, with "." for the root module.
func repositoryModules(t *testing.T, root string) []string {
	t.Helper()
	var modules []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "node_modules", "dist", "tmp", ".gocache", "private", "private-encrypted":
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() != "go.mod" {
			return nil
		}
		relative, relErr := filepath.Rel(root, filepath.Dir(path))
		if relErr != nil {
			return relErr
		}
		modules = append(modules, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		t.Fatalf("cannot walk the repository: %v", err)
	}
	if len(modules) < 2 {
		t.Fatalf("expected the root module and at least one nested module, found %v", modules)
	}
	return modules
}

// workspaceModules parses the use block of go.work. A full go.work parser is
// not needed: the file is written by `go work` and its use paths are one per
// line or inline after the keyword.
func workspaceModules(t *testing.T, root string) map[string]bool {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(root, "go.work"))
	if err != nil {
		t.Fatalf("go.work is missing; without it the nested modules never compile from the root: %v", err)
	}
	declared := map[string]bool{}
	inBlock := false
	for _, raw := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == "use (":
			inBlock = true
		case inBlock && line == ")":
			inBlock = false
		case inBlock && line != "":
			declared[normalizeUsePath(line)] = true
		case strings.HasPrefix(line, "use "):
			declared[normalizeUsePath(strings.TrimPrefix(line, "use "))] = true
		}
	}
	return declared
}

func normalizeUsePath(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "./")
	if value == "" {
		return "."
	}
	return value
}

// makefileTarget returns the recipe lines of one target. Makefile recipes are
// the tab-indented lines following `name:`.
func makefileTarget(t *testing.T, root, name string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(root, "Makefile"))
	if err != nil {
		t.Fatalf("cannot read the Makefile: %v", err)
	}
	var recipe []string
	inTarget := false
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, name+":") {
			inTarget = true
			continue
		}
		if !inTarget {
			continue
		}
		if strings.HasPrefix(line, "\t") {
			recipe = append(recipe, line)
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		break
	}
	if len(recipe) == 0 {
		t.Fatalf("Makefile has no recipe for target %q", name)
	}
	return strings.Join(recipe, "\n")
}
