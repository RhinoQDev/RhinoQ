package unit

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const modulePrefix = "github.com/madebyduy/RhinoQ/"

func TestInternalLayerImportsStayDirected(t *testing.T) {
	root := repositoryRoot(t)
	rules := map[string][]string{
		"contracts": {
			"internal/domain/", "internal/ports/", "internal/application/",
			"internal/runtime/", "internal/adapters/", "internal/infrastructure/",
			"internal/interfaces/", "pkg/",
		},
		"domain": {
			"internal/ports/", "internal/application/", "internal/runtime/",
			"internal/adapters/", "internal/infrastructure/", "internal/interfaces/",
			"pkg/",
		},
		"ports": {
			"internal/application/", "internal/runtime/", "internal/adapters/",
			"internal/infrastructure/", "internal/interfaces/", "pkg/",
		},
		"application": {
			"internal/runtime/", "internal/adapters/", "internal/infrastructure/",
			"internal/interfaces/", "pkg/",
		},
		"runtime": {
			"internal/application/", "internal/adapters/", "internal/infrastructure/",
			"internal/interfaces/", "pkg/",
		},
		"adapters": {
			"internal/application/", "internal/runtime/", "internal/infrastructure/",
			"internal/interfaces/", "pkg/",
		},
	}

	for layer, forbidden := range rules {
		layer := layer
		forbidden := forbidden
		t.Run(layer, func(t *testing.T) {
			assertNoForbiddenImports(t, root, filepath.Join(root, "internal", layer), forbidden)
		})
	}
}

func assertNoForbiddenImports(t *testing.T, root, directory string, forbidden []string) {
	t.Helper()
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, spec := range file.Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			local := strings.TrimPrefix(importPath, modulePrefix)
			for _, prefix := range forbidden {
				if strings.HasPrefix(local, prefix) {
					relative, _ := filepath.Rel(root, path)
					t.Errorf("%s imports forbidden dependency %s", filepath.ToSlash(relative), importPath)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate architecture test")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
}
