# Architecture map

```mermaid
flowchart TB
  I["Agent HTTP / Go API / CLI / SDK"]
  F["Public facade"]
  A["Application use cases"]
  R["Runtime: worker / lease / supervisor"]
  D["Domain decisions"]
  P["Ports"]
  X["Memory / PostgreSQL adapters"]
  DB[("PostgreSQL")]

  I --> F
  F --> A
  F --> R
  A --> D
  A --> P
  R --> D
  R --> P
  X -. "implements" .-> P
  X --> DB
```

Go là authoritative engine. TypeScript là developer-facing SDK. Domain không import adapter/database/framework. Xem [ARCHITECTURE.md](../ARCHITECTURE.md) để đọc dependency rule đầy đủ.

Các sequence/state diagram bám theo implementation nằm tại [Runtime flows](./runtime-flows.md).
