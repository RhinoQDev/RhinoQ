# RhinoQ — Instructions for AI agents

Đọc file này trước khi sửa code.

## Thứ tự đọc bắt buộc

1. `README.md`
2. `ARCHITECTURE.md`
3. `.ai/PROJECT_CONTEXT.md`
4. `.ai/ARCHITECTURE_RULES.md`
5. `.ai/DEFINITION_OF_DONE.md`
6. `.ai/DECISIONS.md` nếu thay đổi kiến trúc hoặc contract

## Quy tắc làm việc

- Không đoán business rule khi chưa có bằng chứng trong repository.
- Không đưa claim throughput, latency hoặc reliability nếu chưa có benchmark/fault evidence.
- Không để Domain biết database, framework, provider hoặc transport.
- Go là ngôn ngữ authoritative cho engine/runtime; TypeScript chỉ là SDK/CLI developer-facing.
- Không đưa correctness logic của lease, retry, effect ledger hoặc job state machine vào SDK.
- Không bypass Application để gọi store trực tiếp từ CLI, Console hoặc adapter.
- Mọi thay đổi public contract phải cập nhật docs, test và changelog phù hợp.
- Mọi thay đổi user-visible hoặc tính năng mới phải cập nhật `README.md` trong
  cùng change. Nếu README không cần đổi, handoff/PR phải ghi rõ lý do.
- Effect phải có idempotency và confirmation policy rõ ràng.
- Unknown external result phải fail-closed hoặc chuyển `uncertain`; không retry mù.
- Không sửa file ngoài phạm vi task.
- Trước khi kết thúc phải báo: file đã đổi, test đã chạy, test chưa chạy và rủi ro còn lại.

## Quy trình tối thiểu

```text
inspect → plan → implement → test → review diff → update docs/changelog → report
```

## Quy tắc đồng bộ README

`README.md` là product contract đầu tiên mà người dùng nhìn thấy, không phải
nhật ký triển khai. Khi thêm hoặc đổi installation, public API, CLI, migration,
operator workflow, capability, limitation hay release status:

1. cập nhật luồng sử dụng hoặc trạng thái tương ứng trong README;
2. không quảng bá behavior chưa có code và test;
3. không giữ claim đã lỗi thời chỉ vì tài liệu chi tiết chưa kịp sửa;
4. kiểm tra mọi command và đường dẫn trong README trước khi bàn giao.
