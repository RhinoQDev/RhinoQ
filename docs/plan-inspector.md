# Plan Inspector

The typed application compiler now exposes its compiled plan to the embedded
operator Workbench when the application starts with `http` enabled. The
read-only endpoint is:

```text
GET /admin/api/plan
```

The page shows each Task's factory marker, compiled adapter/runtime/scope,
retry policy, bounded data path and readiness. A data-path provider gap is
shown as `needs-decision`; it is never silently converted into a default or a
mutation. When the application was not created by the typed compiler, the
endpoint explicitly returns `not-configured`.

The plan is an operator projection of the existing manifest. It contains no
payload, provider secret, handler code or raw file data. It cannot generate a
config patch and does not change dispatch, retry, lease or Task state-machine
authority.
