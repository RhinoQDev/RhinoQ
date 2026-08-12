# Live Task UI

`TaskStore` and `TaskListStore` own the browser transport lifecycle: live SSE,
bounded reconnect, polling fallback, monotonic-version convergence, terminal
shutdown, hidden-tab pause and cleanup. React consumers should start with
`createUseRhinoTaskLive`; framework-neutral consumers subscribe to the store.

`taskUIModel` is the shared presentation contract. Do not independently map
Task states in each screen. A succeeded execution without independent output
evidence must not be displayed as business verified. When a result is recorded
but no resolver is configured, display `Not configured` rather than hiding the
distinction.
