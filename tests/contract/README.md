# tests/contract

Cross-language wire tests. RhinoQ ships two implementations of one contract —
the Go types in `pkg/rhinoq` and the TypeScript client in `sdks/node` — and
neither language's own test suite notices when they stop agreeing.

## How the binding works

One golden file per contract lives in `testdata/contracts`:

| Fixture | Produced by | Consumed by |
|---|---|---|
| `task-contract-v1.json` | `task_wire_test.go` | `sdks/node/test/task-contract-golden.test.mjs` |
| `rule-record-v1.json` | `rule_wire_test.go` | `sdks/node/test/task-cli.test.mjs` (mock Gateway response) |

Go marshals the type and asserts byte equality with the committed file. Node
loads the same bytes as its transport fixture. A field renamed on one side
fails here instead of in an adopter's application.

`golden_registry_test.go` fails when a fixture is read by only one language. A
golden nobody on the other side consumes is a mock with a convincing filename,
not a contract.

## Rules

- The bytes are what the Gateway actually sends. `writeJSON` uses
  `json.NewEncoder`, which HTML-escapes, so `>` appears as `>` in the
  fixtures. Do not "clean that up": the fixture stops being a replay of the
  wire the moment it is prettier than the wire.
- Changing a contract means bumping its schema version and updating both SDKs
  in the same change. Regenerating the golden alone converts a caught break
  into a silent one.
- Durations cross the wire in milliseconds. `RuleRecord.MarshalJSON` exists for
  that reason, and `TestRuleRecordSendsDurationsInMilliseconds` pins the unit
  rather than only the bytes — a nanosecond value parses fine and schedules the
  Rule 1,000,000 times too slowly.
