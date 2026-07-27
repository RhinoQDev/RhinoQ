# RhinoQ

RhinoQ là Go-first durable job queue. Go sở hữu engine/runtime authoritative; TypeScript là SDK và developer interface cho ứng dụng Node.js.

- Product spec: [RHINOQ.md](./RHINOQ.md)
- Architecture blueprint: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Go engine: `cmd/`, `internal/`
- TypeScript SDK: `sdks/typescript/`
- Protocol: `proto/`
- Git/security governance: `AGENTS.md`, `SECURITY.md`, `GOVERNANCE.md`, `.github/`

## Kiểm tra

```bash
go test ./...
npm --prefix sdks/typescript install
npm --prefix sdks/typescript run typecheck
```

PostgreSQL, provider adapters, worker runtime đầy đủ, CLI và Console chưa được gắn hoàn chỉnh. Chúng sẽ đi qua `internal/ports/` và `internal/adapters/`, không đi thẳng vào Domain. TypeScript SDK không chứa correctness engine.
