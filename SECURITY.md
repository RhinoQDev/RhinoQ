# Security policy

## Repository status

RhinoQ hiện đang phát triển private. Không đưa secret, access token, refresh token, production payload hoặc thông tin khách hàng vào repository, issue, log hay commit.

## Báo cáo lỗ hổng

Không mở issue công khai cho lỗ hổng bảo mật. Gửi báo cáo riêng cho maintainer qua kênh bảo mật đã cấu hình của dự án, kèm phiên bản/commit, điều kiện tái hiện, impact và log đã redacted.

Không gửi credential thật. Nếu credential đã xuất hiện trong chat, log hoặc commit, phải revoke/rotate ngay; xóa khỏi file không làm credential cũ mất hiệu lực.

## Security baseline

- Branch protected, không push trực tiếp vào `main`.
- Mọi thay đổi cần pull request và CI pass.
- Secret scanning và dependency scanning chạy trong CI.
- Release dùng signed tag hoặc provenance phù hợp.
- Payload/log phải redacted trước khi lưu.
- Repair/operator actions phải có audit.

