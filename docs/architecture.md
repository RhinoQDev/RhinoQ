# Architecture map

```text
Protocol / SDK / CLI
          ↓
Application use cases
          ↓
Domain state machines
          ↓
Ports
          ↓
Memory / PostgreSQL / provider adapters
          ↓
Runtime supervisor
```

Go là authoritative engine. TypeScript là developer-facing SDK. Domain không import adapter/database/framework. Xem [ARCHITECTURE.md](../ARCHITECTURE.md) để đọc dependency rule đầy đủ.

