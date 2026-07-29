# Security audit — 2026-07-29

Audit này áp dụng cho working tree đang phát triển, không chỉ commit `HEAD`.
Kết quả không phải chứng nhận production-ready và không thay thế pentest.

## Kết luận

- Codex Security CLI đã được chạy thật nhưng **không tạo được report hợp lệ**.
  Không được diễn giải việc này thành “không có finding”.
- `govulncheck` ban đầu tìm thấy 7 đường gọi bị ảnh hưởng. Dependency và
  toolchain đã được nâng; scan lại cả root module và PostgreSQL test module đều
  trả `No vulnerabilities found`.
- `npm audit` trả 0 vulnerability cho Node SDK.
- Gitleaks 8.30.1 không tìm thấy secret trong 42 commit hoặc working tree.
- HTTP Gateway được harden ở các điểm có thể sửa mà không phát minh auth model:
  token tối thiểu 32 byte, compare hash constant-time, mặc định chỉ bind
  loopback, cấm unauthenticated bind ra non-loopback, giới hạn header/thời gian
  đọc, từ chối trailing JSON và không phản chiếu parser/store error thô.
- RhinoQ vẫn chưa có tenant isolation, role-scoped credential, end-user token,
  worker-scoped token, TLS termination tích hợp và data-redaction policy được
  enforce. Đây là release blocker, không phải phần đã giải quyết.

## Codex Security

Tool:

- CLI `@openai/codex-security` 0.1.1;
- bundled plugin 0.1.14;
- model do tool chọn: `gpt-5.6-sol`, reasoning `xhigh`;
- standard full-repository scan;
- source repository:
  <https://github.com/openai/codex-security>;
- official quickstart:
  <https://learn.chatgpt.com/docs/security/cli>.

Đã chạy dry-run thành công trước mỗi môi trường. Scan thật được thử:

1. native Windows, output ngoài repository;
2. native Windows với đường dẫn ngắn `C:\tmp`;
3. Linux container, repository mount read-only và output trên Linux volume.

Cả ba lần đều tới pha phân tích rồi kết thúc bằng:

```text
Could not save the Codex Security scan:
scan-manifest.json: expected a regular file inside the scan directory.
```

Output directory/volume đều rỗng sau lỗi. Không có sealed
`scan-manifest.json`, `findings.json`, `coverage.json` hoặc `report.md` để
export/validate. Vì lỗi lặp lại trên Linux volume, nguyên nhân không còn được
quy cho NTFS hay độ dài đường dẫn. Không dùng partial output và không ghi nhận
bất kỳ “finding” nào từ Codex Security.

Không cài Git hook và không thêm Codex Security vào CI: beta tool chưa chứng
minh được khả năng tạo artifact tái lập trong repository này.

## Dependency findings và remediation

`govulncheck` trước remediation tìm thấy các đường gọi bị ảnh hưởng:

- `GO-2026-5004`: pgx placeholder confusion khi dùng simple protocol; fixed từ
  `github.com/jackc/pgx/v5` 5.9.2;
- `GO-2026-5970`: infinite loop trong `golang.org/x/text`; fixed từ 0.39.0;
- 5 advisory thuộc standard library của Go 1.26.2, với bản vá muộn nhất cần
  Go 1.26.5.

Remediation:

- minimum module baseline: Go 1.25.0, vì pgx 5.9.2 và x/text 0.39.0 yêu cầu
  Go 1.25;
- preferred/pinned toolchain: Go 1.26.5;
- pgx: 5.7.2 → 5.9.2;
- x/text: 0.21.0 → 0.39.0;
- x/sync được dependency graph nâng lên 0.21.0;
- CI chuyển sang `actions/setup-go@v7`, bản hỗ trợ `toolchain` directive;
- Security workflow chạy `govulncheck` cho cả hai Go module và `npm audit` cho
  Node SDK.

Verification sau remediation:

```text
root module:             No vulnerabilities found.
tests/postgres module:   No vulnerabilities found.
Node SDK npm audit:      0 total vulnerabilities.
```

Đây là snapshot theo database advisory tại ngày audit; CI phải tiếp tục chạy
định kỳ vì kết quả có thể đổi khi advisory mới được công bố.

## Trust-boundary review

### Đã harden

- Agent không khởi động với bearer token ngắn hơn 32 byte.
- Token được SHA-256 trước khi constant-time compare, tránh nhánh so sánh theo
  độ dài chuỗi gốc.
- Default bind đổi từ mọi interface sang `127.0.0.1:8080`.
- `RHINOQ_AGENT_ALLOW_UNAUTHENTICATED=true` chỉ được bind loopback.
- HTTP server có `ReadHeaderTimeout`, `ReadTimeout`, `IdleTimeout` và
  `MaxHeaderBytes`; request body vẫn được chặn bởi `MaxBytesReader`.
- JSON decoder chỉ nhận đúng một value và không trả parser detail/request data
  về client.
- Readiness và fallback error không trả raw store error.
- Workbench tiếp tục bind loopback, read-only, same-origin, CSP và không xuất
  payload.
- Rule SQL tiếp tục chạy trong read-only transaction với statement timeout;
  docs không gọi syntax guard là SQL sandbox.

### Release blocker còn mở

1. **Authorization model:** một deployment bearer token hiện có quyền producer,
   worker và operator trên mọi queue/task. Chưa có tenant isolation, per-role
   credential, owner scope, revocation hoặc worker token gắn với Execution.
2. **Transport:** Agent là HTTP; deployment remote phải đặt sau TLS-terminating
   reverse proxy/service mesh và network policy. Không expose trực tiếp.
3. **Sensitive data:** payload, evidence, result reference và provider error có
   thể chứa secret/PII. Redaction, retention, field policy và signed-URL
   non-persistence mới là contract tài liệu, chưa được enforce end-to-end.
4. **Rule database role:** read-only transaction không vô hiệu hóa PostgreSQL
   function/extension có side effect. Production cần role riêng, không có
   network/filesystem side-effect grants.
5. **Abuse controls:** chưa có HTTP rate limit, failed-auth audit,
   credential rotation protocol hoặc request identity.
6. **Task API:** `ownerId` hiện là metadata do deployment-trusted caller gửi,
   không phải authorization boundary. Không được đưa API Task hiện tại trực
   tiếp cho frontend/end user.

> Post-audit remediation: Snapshot hiện trả `ownerId`, và Gateway có optional
> owner-scoped credentials chỉ được đọc Task/result cùng owner và request
> cancellation. Cross-owner access trả `404`; queue/operator API và arbitrary
> Task transition vẫn yêu cầu operator token. Organization membership, RBAC,
> rotation và browser-safe authentication vẫn là release blocker, nên kết luận
> không expose Gateway trực tiếp ra frontend vẫn giữ nguyên.

## Coverage chưa có

- Codex Security sealed report và coverage map;
- local CodeQL run;
- DAST/fuzz/pentest với deployment thật;
- test TLS/reverse proxy và credential rotation;
- organization/RBAC authorization, credential rotation và deployment-level
  tenant policy tests; owner-scoped Task isolation đã được bổ sung sau audit;
- full PostgreSQL suite tại thời điểm audit; fixture suppression dùng thời gian
  cố định đã quá hạn. Fixture sau đó đã chuyển sang PostgreSQL clock, có
  regression coverage cho cả suppression đang hiệu lực và đã hết hạn, và CI
  chạy suite fresh/shuffled. Việc sửa này không mở rộng hồi tố phạm vi audit.

## Lệnh tái lập

```text
go run golang.org/x/vuln/cmd/govulncheck@v1.6.0 ./...
(cd tests/postgres && go run golang.org/x/vuln/cmd/govulncheck@v1.6.0 ./...)
(cd sdks/node && npm audit)
gitleaks git <repo> --redact
gitleaks dir <repo> --redact
```

Codex Security chỉ nên được thử lại sau khi CLI/plugin có bản mới hoặc lỗi
manifest được xác nhận đã sửa. Khi thử lại, output phải ở private directory
ngoài repository và chỉ chấp nhận report đã seal/export thành công.
