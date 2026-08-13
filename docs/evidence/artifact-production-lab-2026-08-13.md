# Artifact Production Lab — 2026-08-13

Environment: Node 22.22.1 on Windows; AWS S3 `us-east-1`; FFmpeg 5.1.9 in
`node:22-bookworm-slim`. Credentials and object keys are not recorded.

## Evidence obtained

- 405 Node tests: 395 passed, 10 environment-gated skips, zero failures.
- All Go packages passed `go test ./...`.
- Live S3 multipart E2E: 11,534,353 bytes, three parts, exact HEAD readback,
  object deleted.
- Live restart fault: first part uploaded, provider recreated, one part
  recovered, four total parts completed, exact 16,777,247-byte readback, object
  deleted.
- FFmpeg image ran as UID 1000, `/work` was writable, `libx264` and `aac` were
  present, and a two-second video/audio output was produced. Missing input and
  missing encoder failed. Runtime readiness returned false when configured
  minimum free bytes exceeded the volume.
- Synthetic 1,000-session multipart planning stayed within provider part and
  memory bounds.
- Incremental SHA-256 matched Node/OpenSSL for 256 MiB. Hashing now overlaps
  multipart upload and yields between bounded chunks.

## Performance interpretation

The portable browser SHA-256 implementation was much slower than native
OpenSSL in the local Node comparison (roughly 10.5 s versus 0.7–1.0 s for 256
MiB). This is expected and is not evidence that RhinoQ beats a native hashing
implementation. Event-loop delay in this Node/Blob synthetic remained high and
must not be presented as browser UI evidence. A browser/Web Worker campaign is
still required for a UI responsiveness claim.

RhinoQ's demonstrated advantage is currently reduced integration code plus
durable resume, ownership fencing, bounded planning, readback, uncertainty and
cleanup. Real S3 throughput superiority over hand-written AWS SDK code is not
claimed; both use the AWS SDK/provider path.

## Reproduce

```bash
npm --prefix sdks/node test
npm --prefix sdks/node run lab:artifacts
npm --prefix sdks/node run test:s3
npm --prefix sdks/node run test:s3:fault
go test ./...
```
