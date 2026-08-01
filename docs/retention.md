# Evidence retention and partitioning

Hot Task/Job state and append-only evidence have different retention needs.

- Keep active Tasks, ProviderOperations, Findings and repair plans online.
- Export terminal Execution, attempt, effect, outcome, notification and audit
  evidence before deletion. Preserve correlation IDs and hashes.
- Start monthly range partitioning when an evidence table's index no longer
  fits the deployment memory budget or routine retention deletes create vacuum
  pressure. This is an observed threshold, not a fixed row-count claim.
- Delete one detached/archived partition at a time; never run an unbounded
  delete against the hot write table.
- Retention must exceed the longest provider dispute, audit and repair window.

RhinoQ does not automatically choose a legal retention period for the adopter.
