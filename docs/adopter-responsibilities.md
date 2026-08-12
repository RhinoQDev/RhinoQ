# Adopter responsibilities

The application owns authenticated `ownerId`, authorized `tenantId`, stable
runtime scope and application keys, provider clients, business verifiers and
real repair handlers. Use `validateRuntimeIdentity()` during startup and
`deterministicRuntimeId()` when an existing stable business key needs an opaque
Task or Execution ID.

Result resolvers must receive owner and tenant context. `localResult()` is for
loopback development; `s3CompatibleResult()` delegates signing to the
application's existing storage SDK; `proxyResult()` keeps storage references
behind an application route.

For multi-replica Shadow Mode, configure a stable replica ID and the PostgreSQL
adoption store. A memory store is process-local evidence only.
