package agent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

const (
	scopeOperatorToken = "scope-operator-token-at-least-32-bytes"
	scopeAliceToken    = "scope-alice-token-that-is-at-least-32-bytes"
	scopeBobToken      = "scope-bob-token-that-is-at-least-32-bytes---"
)

// scopeServer builds an Agent with two owner credentials and seeds one Task for
// each owner, plus one Task with no owner at all.
//
// Seeding goes through a separate default-role Agent on the same Client, because
// creating a Task needs task:write and the role under test may deliberately lack
// it. Sharing the Client is what makes the two Agents see the same Tasks.
func scopeServer(t *testing.T, role string) *Server {
	t.Helper()
	client := rhinoq.NewInMemory()
	credentials := []TaskCredential{
		{OwnerID: "alice", Token: scopeAliceToken},
		{OwnerID: "bob", Token: scopeBobToken},
	}
	seeder, err := New(Config{Client: client, Token: scopeOperatorToken})
	if err != nil {
		t.Fatal(err)
	}
	seed := func(id, owner string) {
		body := `{"id":"` + id + `","type":"export","definitionVersion":1`
		if owner != "" {
			body += `,"ownerId":"` + owner + `"`
		}
		body += `}`
		request := httptest.NewRequest(http.MethodPost, "/v1/tasks", bytes.NewBufferString(body))
		request.Header.Set("Authorization", "Bearer "+scopeOperatorToken)
		response := httptest.NewRecorder()
		seeder.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("seed %s: %d %s", id, response.Code, response.Body.String())
		}
	}
	// A Task is created pending, and pending cannot be cancelled: only queued and
	// running can. Moving the seeds to queued is what makes them cancellable, so
	// the cancel tests exercise authorization rather than a state precondition.
	queue := func(id string) {
		request := httptest.NewRequest(http.MethodPost, "/v1/tasks/"+id+"/state",
			bytes.NewBufferString(`{"expectedVersion":1,"state":"queued"}`))
		request.Header.Set("Authorization", "Bearer "+scopeOperatorToken)
		response := httptest.NewRecorder()
		seeder.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("queue %s: %d %s", id, response.Code, response.Body.String())
		}
	}
	seed("task-alice", "alice")
	seed("task-bob", "bob")
	seed("task-unowned", "")
	queue("task-alice")
	queue("task-bob")

	server, err := New(Config{
		Client: client, Token: scopeOperatorToken, Role: role,
		TaskCredentials: credentials,
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

// taskVersion reads the Task's current aggregate version, which a cancel must
// present as its write precondition. Hard-coding 1 would make the test depend on
// how many versions creation happens to consume.
func taskVersion(t *testing.T, server *Server, id, token string) int64 {
	t.Helper()
	response := get(t, server, "/v1/tasks/"+id, token)
	if response.Code != http.StatusOK {
		t.Fatalf("read %s for its version: %d %s", id, response.Code, response.Body.String())
	}
	var snapshot struct {
		EntityVersion int64 `json:"entityVersion"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	return snapshot.EntityVersion
}

func get(t *testing.T, server *Server, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func cancel(t *testing.T, server *Server, id, token string, version int64) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/v1/tasks/"+id+"/cancel",
		bytes.NewBufferString(`{"expectedVersion":`+strconv.FormatInt(version, 10)+`}`))
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func TestOwnerCredentialReadsOnlyItsOwnTask(t *testing.T) {
	server := scopeServer(t, "")
	if response := get(t, server, "/v1/tasks/task-alice", scopeAliceToken); response.Code != http.StatusOK {
		t.Fatalf("alice was denied her own Task: %d %s", response.Code, response.Body.String())
	}
	if response := get(t, server, "/v1/tasks/task-alice", scopeBobToken); response.Code != http.StatusNotFound {
		t.Fatalf("bob read alice's Task: %d %s", response.Code, response.Body.String())
	}
}

// Cross-scope access must be concealed as 404, never answered as 403. A 403 for
// a Task that exists and a 404 for an id that does not turns every read route
// into an oracle for "does this id exist", one bit per request.
func TestCrossScopeAccessIsConcealedNotForbidden(t *testing.T) {
	server := scopeServer(t, "")
	paths := []string{
		"/v1/tasks/task-alice",
		"/v1/tasks/task-alice/summary",
		"/v1/tasks/task-alice/executions/page?limit=1",
		"/v1/tasks/task-alice/result",
		"/v1/tasks/task-alice/execution-results",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			foreign := get(t, server, path, scopeBobToken)
			if foreign.Code != http.StatusNotFound {
				t.Fatalf("expected 404 concealment, got %d %s", foreign.Code, foreign.Body.String())
			}
			// The concealed answer must not differ from the answer for an id that
			// was never issued, or the difference is itself the leak.
			missing := get(t, server, strings.Replace(path, "task-alice", "task-never-existed", 1), scopeBobToken)
			if missing.Code != foreign.Code {
				t.Errorf("a foreign Task answered %d but a missing one answered %d",
					foreign.Code, missing.Code)
			}
		})
	}
}

// A Task with no owner belongs to no scope, so a scoped credential must not
// reach it. Treating an empty owner as "matches everyone" is the exact bug the
// scope gate exists to prevent.
func TestUnownedTaskIsNotVisibleToScopedCredential(t *testing.T) {
	server := scopeServer(t, "")
	if response := get(t, server, "/v1/tasks/task-unowned", scopeAliceToken); response.Code != http.StatusNotFound {
		t.Fatalf("a scoped credential reached an unowned Task: %d %s", response.Code, response.Body.String())
	}
	// The operator is tenant-wide and must still see it.
	if response := get(t, server, "/v1/tasks/task-unowned", scopeOperatorToken); response.Code != http.StatusOK {
		t.Fatalf("operator was denied an unowned Task: %d %s", response.Code, response.Body.String())
	}
}

func TestOwnerCredentialCanCancelItsOwnTaskAndNotAnothers(t *testing.T) {
	server := scopeServer(t, "")
	version := taskVersion(t, server, "task-alice", scopeAliceToken)
	if response := cancel(t, server, "task-alice", scopeAliceToken, version); response.Code != http.StatusOK {
		t.Fatalf("alice could not cancel her own Task: %d %s", response.Code, response.Body.String())
	}
	if response := cancel(t, server, "task-bob", scopeAliceToken, 1); response.Code != http.StatusNotFound {
		t.Fatalf("alice cancelled bob's Task: %d %s", response.Code, response.Body.String())
	}
}

// The role gate now applies to owner routes too. Before this, any authenticated
// operator token could cancel regardless of its configured role, because the
// owner routes only ever compared owners.
func TestViewerRoleCannotCancelThroughAnOwnerRoute(t *testing.T) {
	server := scopeServer(t, "viewer")
	// A viewer may read.
	if response := get(t, server, "/v1/tasks/task-alice", scopeOperatorToken); response.Code != http.StatusOK {
		t.Fatalf("viewer was denied a read: %d %s", response.Code, response.Body.String())
	}
	// It may not mutate, and the denial is honest rather than concealed: the
	// caller can already see the Task exists, so 404 would only hide a fixable
	// permission problem.
	response := cancel(t, server, "task-alice", scopeOperatorToken, taskVersion(t, server, "task-alice", scopeOperatorToken))
	if response.Code != http.StatusForbidden {
		t.Fatalf("viewer cancelled a Task: %d %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "task:write") {
		t.Errorf("the denial should name the missing permission: %s", response.Body.String())
	}
}

// An owner credential holds task:write for its own Tasks, so the role gate must
// not accidentally block the owner flow the Task Center depends on.
func TestOwnerRoleGrantsWriteWithinItsScope(t *testing.T) {
	server := scopeServer(t, "viewer")
	// The Agent's own role is viewer, but an owner credential carries
	// task_owner, so alice can still cancel her own Task.
	if response := cancel(t, server, "task-alice", scopeAliceToken, taskVersion(t, server, "task-alice", scopeAliceToken)); response.Code != http.StatusOK {
		t.Fatalf("owner credential was denied its own cancel: %d %s", response.Code, response.Body.String())
	}
}
