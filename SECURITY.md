# Security policy

## Trạng thái

RhinoQ đang ở active development và chưa có production-ready release. Chưa có
version nào được hỗ trợ security patch dài hạn; fix bảo mật đi vào `main`.

Không đưa secret, access token, refresh token, production payload hoặc thông
tin khách hàng vào repository, issue, log hay commit.

## Báo cáo lỗ hổng

Không mở issue công khai cho lỗ hổng bảo mật. Dùng
[GitHub private vulnerability reporting](https://github.com/madebyduy/RhinoQ/security/advisories/new)
để gửi báo cáo riêng, kèm phiên bản/commit, điều kiện tái hiện, impact và log
đã redacted.

Không gửi credential thật. Nếu credential đã xuất hiện trong chat, log hoặc
commit, phải revoke/rotate ngay; xóa khỏi file không làm credential cũ mất hiệu
lực.

## Ghi chú về Integrity Rules

Rule dùng SQL do developer viết. Explain gate kiểm shape, timeout, limit và plan
cost — nó **không phải SQL sandbox**. Production phải chạy Rule bằng một
PostgreSQL role read-only riêng, và không grant function hay extension có side
effect ra filesystem/network. Xem [`docs/rules.md`](./docs/rules.md).

## Security baseline

- Branch protected, không push trực tiếp vào `main`.
- Mọi thay đổi cần pull request và CI pass.
- Secret scanning và dependency scanning chạy trong CI.
- Release dùng signed tag hoặc provenance phù hợp.
- Payload/log phải redacted trước khi lưu.
- Repair/operator actions phải có audit.
