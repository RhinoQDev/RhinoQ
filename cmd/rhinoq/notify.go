package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

// Notification destinations live in a small local registry rather than in the
// database or in Go source.
//
// The README promises that Findings reach people, but until this command
// existed the only way to configure a destination was to build a
// rhinoq.NotificationDestination in Go and embed it in an application - which a
// Node or Python team cannot do at all. A registry file closes that gap without
// a migration.
//
// No secret is ever written to it. The file records the *name of an
// environment variable*, and the value is read at send time. A registry that
// leaks is then a list of URLs, not a set of working credentials, and the file
// can be committed if a team wants their destinations reviewed.
const notifyRegistryVersion = 1

type notifyDestination struct {
	Name string `json:"name"`
	// Kind is webhook or slack.
	Kind string `json:"kind"`
	// URL is the endpoint. It is empty when URLEnv is used instead, which is
	// the right choice for Slack, where the URL is itself the credential.
	URL string `json:"url,omitempty"`
	// URLEnv names an environment variable holding the endpoint.
	URLEnv string `json:"urlEnv,omitempty"`
	// SecretEnv names the environment variable holding the HMAC secret. An
	// empty value means the payload is sent unsigned.
	SecretEnv string `json:"secretEnv,omitempty"`
	// TimeoutMs bounds one delivery attempt.
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// IncludeEvidence is opt-in because evidence may carry business data.
	IncludeEvidence bool `json:"includeEvidence,omitempty"`
	// GracePeriodMs delays a first notification so a Finding that resolves
	// itself within the window never reaches a person.
	GracePeriodMs int64 `json:"gracePeriodMs,omitempty"`
	// FindingBaseURL turns a notification into a link an operator can open.
	FindingBaseURL string `json:"findingBaseUrl,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
}

type notifyRegistry struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Destinations  []notifyDestination `json:"destinations"`
}

func runNotify(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(output, notifyUsage)
		return 2
	}
	switch args[0] {
	case "add":
		return runNotifyAdd(args[1:], getenv, output)
	case "list":
		return runNotifyList(args[1:], getenv, output)
	case "remove":
		return runNotifyRemove(args[1:], getenv, output)
	case "test":
		return runNotifyTest(args[1:], getenv, output)
	case "send":
		return runNotifySend(args[1:], getenv, output)
	default:
		fmt.Fprintln(output, notifyUsage)
		return 2
	}
}

const notifyUsage = "Usage: rhinoq notify <add|list|remove|test|send>"

func notifyRegistryPath(getenv func(string) string) string {
	if custom := strings.TrimSpace(getenv("RHINOQ_NOTIFY_CONFIG")); custom != "" {
		return custom
	}
	return filepath.Join(".rhinoq", "notifications.json")
}

func loadNotifyRegistry(path string) (notifyRegistry, error) {
	registry := notifyRegistry{SchemaVersion: notifyRegistryVersion}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return registry, nil
	}
	if err != nil {
		return registry, err
	}
	if err := json.Unmarshal(raw, &registry); err != nil {
		return notifyRegistry{}, fmt.Errorf("%s is not valid RhinoQ notify JSON: %w", path, err)
	}
	if registry.SchemaVersion != notifyRegistryVersion {
		return notifyRegistry{}, fmt.Errorf(
			"%s uses schema version %d; this CLI writes version %d",
			path, registry.SchemaVersion, notifyRegistryVersion)
	}
	return registry, nil
}

func saveNotifyRegistry(path string, registry notifyRegistry) error {
	registry.SchemaVersion = notifyRegistryVersion
	sort.Slice(registry.Destinations, func(i, j int) bool {
		return registry.Destinations[i].Name < registry.Destinations[j].Name
	})
	encoded, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}
	if directory := filepath.Dir(path); directory != "" && directory != "." {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return err
		}
	}
	// 0600 even though no secret is stored: a Slack URL is a credential in
	// everything but name, and the file records which variables to look for.
	return os.WriteFile(path, append(encoded, '\n'), 0o600)
}

func runNotifyAdd(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") ||
		strings.TrimSpace(args[0]) == "" {
		fmt.Fprintln(output, "Usage: rhinoq notify add <name> --webhook <url> [--secret-env VAR]")
		fmt.Fprintln(output, "       rhinoq notify add <name> --slack <url>")
		fmt.Fprintln(output, "       rhinoq notify add <name> --kind slack --url-env RHINOQ_NOTIFY_URL_OPS")
		return 2
	}
	name := strings.TrimSpace(args[0])
	flags := flag.NewFlagSet("notify add", flag.ContinueOnError)
	flags.SetOutput(output)
	webhook := flags.String("webhook", "", "generic signed webhook URL")
	slack := flags.String("slack", "", "Slack incoming webhook URL")
	kind := flags.String("kind", "", "webhook or slack")
	endpoint := flags.String("url", "", "destination URL")
	urlEnv := flags.String("url-env", "", "environment variable holding the URL")
	secretEnv := flags.String("secret-env", "", "environment variable holding the HMAC secret")
	timeout := flags.Duration("timeout", 10*time.Second, "per-delivery timeout")
	includeEvidence := flags.Bool("include-evidence", false, "send Finding evidence; it may contain business data")
	grace := flags.Duration("grace", 0, "delay a first notification by this long")
	linkBase := flags.String("link-base", "", "base URL used to build a Finding link")
	replace := flags.Bool("replace", false, "overwrite an existing destination with this name")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(output, "FAIL notify add accepts exactly one name")
		return 2
	}

	destination := notifyDestination{
		Name: name, Kind: strings.TrimSpace(*kind),
		URL: strings.TrimSpace(*endpoint), URLEnv: strings.TrimSpace(*urlEnv),
		SecretEnv: strings.TrimSpace(*secretEnv),
		TimeoutMs: timeout.Milliseconds(), IncludeEvidence: *includeEvidence,
		GracePeriodMs:  grace.Milliseconds(),
		FindingBaseURL: strings.TrimSpace(*linkBase),
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}
	// The shorthands exist because "--slack <url>" is what somebody typing this
	// for the first time will try.
	if strings.TrimSpace(*slack) != "" {
		destination.Kind, destination.URL = "slack", strings.TrimSpace(*slack)
	}
	if strings.TrimSpace(*webhook) != "" {
		destination.Kind, destination.URL = "webhook", strings.TrimSpace(*webhook)
	}
	if destination.Kind == "" {
		destination.Kind = "webhook"
	}
	if destination.Kind != "webhook" && destination.Kind != "slack" {
		fmt.Fprintf(output, "FAIL --kind must be webhook or slack, got %q\n", destination.Kind)
		return 2
	}
	if destination.URL == "" && destination.URLEnv == "" {
		fmt.Fprintln(output, "FAIL a destination needs --webhook/--slack/--url or --url-env")
		return 2
	}
	if destination.URL != "" && destination.URLEnv != "" {
		fmt.Fprintln(output, "FAIL --url and --url-env name the same thing twice; use one")
		return 2
	}
	if destination.URL != "" {
		if reason := validateNotifyURL(destination.URL); reason != "" {
			fmt.Fprintf(output, "FAIL %s\n", reason)
			return 2
		}
	}
	if destination.Kind == "webhook" && destination.SecretEnv == "" {
		// Not fatal: a receiver behind mTLS or a private network may not want
		// an HMAC. It is loud because an unsigned webhook cannot tell a real
		// RhinoQ event from anything else that can reach the URL.
		fmt.Fprintln(output, "WARN no --secret-env: payloads will be sent unsigned.")
		fmt.Fprintln(output, "     A receiver cannot then tell a RhinoQ event from a forged one.")
		fmt.Fprintf(output, "     Fix: rhinoq notify add %s --webhook <url> --secret-env %s\n",
			name, defaultSecretEnv(name))
	}

	path := notifyRegistryPath(getenv)
	registry, err := loadNotifyRegistry(path)
	if err != nil {
		return printOperationError(output, err)
	}
	for index, existing := range registry.Destinations {
		if existing.Name != name {
			continue
		}
		if !*replace {
			fmt.Fprintf(output, "FAIL destination %q already exists in %s\n", name, path)
			fmt.Fprintf(output, "     Fix: rhinoq notify add %s ... --replace\n", name)
			return 1
		}
		destination.CreatedAt = existing.CreatedAt
		registry.Destinations[index] = destination
		if err := saveNotifyRegistry(path, registry); err != nil {
			return printOperationError(output, err)
		}
		fmt.Fprintf(output, "PASS destination %q replaced in %s\n", name, path)
		printNotifyNextSteps(output, name, destination)
		return 0
	}
	registry.Destinations = append(registry.Destinations, destination)
	if err := saveNotifyRegistry(path, registry); err != nil {
		return printOperationError(output, err)
	}
	fmt.Fprintf(output, "PASS destination %q added to %s\n", name, path)
	printNotifyNextSteps(output, name, destination)
	return 0
}

func printNotifyNextSteps(output io.Writer, name string, destination notifyDestination) {
	if destination.SecretEnv != "" {
		fmt.Fprintf(output, "INFO the secret is read from %s at send time and is not stored.\n",
			destination.SecretEnv)
	}
	if destination.URLEnv != "" {
		fmt.Fprintf(output, "INFO the URL is read from %s at send time and is not stored.\n",
			destination.URLEnv)
	}
	fmt.Fprintln(output, "NEXT prove the endpoint before trusting it:")
	fmt.Fprintf(output, "  rhinoq notify test %s\n", name)
}

// validateNotifyURL repeats the sender's own rule early so the mistake is
// reported while the operator is still typing, not on the first real Finding.
func validateNotifyURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return fmt.Sprintf("%q is not a URL", raw)
	}
	if parsed.Scheme == "https" {
		return ""
	}
	host := parsed.Hostname()
	if parsed.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1") {
		return ""
	}
	return "a notification URL must use HTTPS (HTTP is allowed only for loopback tests)"
}

func defaultSecretEnv(name string) string {
	return "RHINOQ_NOTIFY_SECRET_" + strings.ToUpper(
		strings.NewReplacer("-", "_", ".", "_", " ", "_").Replace(name),
	)
}

func runNotifyList(args []string, getenv func(string) string, output io.Writer) int {
	flags := flag.NewFlagSet("notify list", flag.ContinueOnError)
	flags.SetOutput(output)
	asJSON := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	path := notifyRegistryPath(getenv)
	registry, err := loadNotifyRegistry(path)
	if err != nil {
		return printOperationError(output, err)
	}
	if *asJSON {
		// The registry holds no secrets, but a Slack URL is a credential, so
		// even the machine-readable form is redacted.
		redacted := make([]notifyDestination, 0, len(registry.Destinations))
		for _, destination := range registry.Destinations {
			destination.URL = redactURL(destination.URL)
			redacted = append(redacted, destination)
		}
		return printJSON(output, map[string]any{"destinations": redacted})
	}
	table := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "NAME\tKIND\tENDPOINT\tSIGNED\tSECRET READY\tEVIDENCE")
	for _, destination := range registry.Destinations {
		endpoint := redactURL(destination.URL)
		if destination.URLEnv != "" {
			endpoint = "$" + destination.URLEnv
			if getenv(destination.URLEnv) == "" {
				endpoint += " (unset)"
			}
		}
		signed, ready := "no", "—"
		if destination.SecretEnv != "" {
			signed = "hmac-sha256"
			ready = "no · $" + destination.SecretEnv + " is empty"
			if getenv(destination.SecretEnv) != "" {
				ready = "yes"
			}
		}
		evidence := "omitted"
		if destination.IncludeEvidence {
			evidence = "included"
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%s\n",
			destination.Name, destination.Kind, endpoint, signed, ready, evidence)
	}
	_ = table.Flush()
	fmt.Fprintf(output, "\n%d destination(s) in %s\n", len(registry.Destinations), path)
	if len(registry.Destinations) == 0 {
		fmt.Fprintln(output, "Add one:")
		fmt.Fprintln(output, "  rhinoq notify add ops --webhook https://example.com/hooks/rhinoq --secret-env RHINOQ_NOTIFY_SECRET_OPS")
	}
	return 0
}

// redactURL keeps enough of a destination to recognise it and not enough to
// use it. A Slack incoming webhook URL is a bearer credential.
func redactURL(raw string) string {
	if raw == "" {
		return "—"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "(unparsable)"
	}
	path := parsed.EscapedPath()
	if len(path) > 12 {
		path = path[:12] + "…"
	}
	return parsed.Scheme + "://" + parsed.Host + path
}

func runNotifyRemove(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		fmt.Fprintln(output, "Usage: rhinoq notify remove <name>")
		return 2
	}
	name := strings.TrimSpace(args[0])
	path := notifyRegistryPath(getenv)
	registry, err := loadNotifyRegistry(path)
	if err != nil {
		return printOperationError(output, err)
	}
	kept := make([]notifyDestination, 0, len(registry.Destinations))
	for _, destination := range registry.Destinations {
		if destination.Name != name {
			kept = append(kept, destination)
		}
	}
	if len(kept) == len(registry.Destinations) {
		fmt.Fprintf(output, "FAIL no destination named %q in %s\n", name, path)
		return 1
	}
	registry.Destinations = kept
	if err := saveNotifyRegistry(path, registry); err != nil {
		return printOperationError(output, err)
	}
	fmt.Fprintf(output, "PASS destination %q removed from %s\n", name, path)
	return 0
}

// resolveNotifyDestination turns a registry entry into a live destination by
// reading the environment. It is the only place a secret is in memory.
func resolveNotifyDestination(
	getenv func(string) string,
	name string,
	output io.Writer,
) (rhinoq.NotificationDestination, bool) {
	path := notifyRegistryPath(getenv)
	registry, err := loadNotifyRegistry(path)
	if err != nil {
		fmt.Fprintf(output, "FAIL %v\n", err)
		return rhinoq.NotificationDestination{}, false
	}
	for _, entry := range registry.Destinations {
		if entry.Name != name {
			continue
		}
		endpoint := entry.URL
		if entry.URLEnv != "" {
			endpoint = strings.TrimSpace(getenv(entry.URLEnv))
			if endpoint == "" {
				fmt.Fprintf(output, "FAIL %s is empty, so destination %q has no URL\n",
					entry.URLEnv, name)
				fmt.Fprintf(output, "     Fix: export %s=<url>\n", entry.URLEnv)
				return rhinoq.NotificationDestination{}, false
			}
		}
		secret := ""
		if entry.SecretEnv != "" {
			secret = getenv(entry.SecretEnv)
			if secret == "" {
				fmt.Fprintf(output, "FAIL %s is empty, so destination %q cannot be signed\n",
					entry.SecretEnv, name)
				fmt.Fprintln(output, "     Sending unsigned would silently weaken a destination that")
				fmt.Fprintln(output, "     was configured to be signed.")
				fmt.Fprintf(output, "     Fix: export %s=<secret>\n", entry.SecretEnv)
				return rhinoq.NotificationDestination{}, false
			}
		}
		timeout := time.Duration(entry.TimeoutMs) * time.Millisecond
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		return rhinoq.NotificationDestination{
			URL: endpoint, Kind: entry.Kind, Secret: secret, Timeout: timeout,
			IncludeEvidence: entry.IncludeEvidence,
			GracePeriod:     time.Duration(entry.GracePeriodMs) * time.Millisecond,
			FindingBaseURL:  entry.FindingBaseURL,
		}, true
	}
	fmt.Fprintf(output, "FAIL no destination named %q in %s\n", name, path)
	fmt.Fprintln(output, "     List what is configured: rhinoq notify list")
	return rhinoq.NotificationDestination{}, false
}

func runNotifyTest(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 || strings.TrimSpace(args[0]) == "" ||
		strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(output, "Usage: rhinoq notify test <name>")
		return 2
	}
	name := strings.TrimSpace(args[0])
	destination, ok := resolveNotifyDestination(getenv, name, output)
	if !ok {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), destination.Timeout+5*time.Second)
	defer cancel()
	receipt, err := rhinoq.SendTestNotification(ctx, destination)
	if err != nil {
		fmt.Fprintf(output, "FAIL destination %q did not accept the test event: %v\n", name, err)
		fmt.Fprintln(output, "     Nothing was written; no Finding or delivery record exists.")
		fmt.Fprintln(output, "     Check the URL, the receiver's signature verification and its TLS.")
		return 1
	}
	fmt.Fprintf(output, "PASS destination %q accepted event %s\n", name, receipt.ID)
	fmt.Fprintf(output, "     type=%s severity=%s sent=%s\n",
		receipt.Type, receipt.Severity, receipt.SentAt.Format(time.RFC3339))
	if destination.Secret != "" {
		fmt.Fprintln(output, "     The receiver should have verified X-RhinoQ-Signature: v1=<hmac-sha256>.")
	}
	fmt.Fprintln(output, "     No business data was sent and nothing was recorded.")
	return 0
}

func runNotifySend(args []string, getenv func(string) string, output io.Writer) int {
	if len(args) == 0 || strings.TrimSpace(args[0]) == "" ||
		strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(output, "Usage: rhinoq notify send <name> --rule <id> --subject-type <type> --subject <id> --version <n>")
		return 2
	}
	name := strings.TrimSpace(args[0])
	flags := flag.NewFlagSet("notify send", flag.ContinueOnError)
	flags.SetOutput(output)
	ruleID := flags.String("rule", "", "Rule ID")
	subjectType := flags.String("subject-type", "", "business subject type")
	subjectID := flags.String("subject", "", "business subject ID")
	version := flags.Int("version", -1, "Rule invariant version")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	if *ruleID == "" || *subjectType == "" || *subjectID == "" || *version < 0 {
		fmt.Fprintln(output, "FAIL --rule, --subject-type, --subject and --version are required")
		return 2
	}
	destination, ok := resolveNotifyDestination(getenv, name, output)
	if !ok {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, closer, err := openIntegrityClient(ctx, getenv)
	if err != nil {
		return printOperationError(output, err)
	}
	defer closer.Close()
	receipt, err := client.SendFindingNotification(ctx, rhinoq.FindingKey{
		RuleID: *ruleID, SubjectType: *subjectType,
		SubjectID: *subjectID, InvariantVersion: *version,
	}, destination)
	if err != nil {
		return printOperationError(output, err)
	}
	// "deduplicated" and "deferred" are results, not failures: the ledger did
	// its job, or the grace period has not expired yet.
	fmt.Fprintf(output, "PASS %s · event %s · severity %s\n",
		receipt.Status, receipt.ID, receipt.Severity)
	return 0
}
