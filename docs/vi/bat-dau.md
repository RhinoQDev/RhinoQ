# Bắt đầu dùng RhinoQ trong 5 phút

Muốn xem giao diện trước khi cài hạ tầng, chạy:

```powershell
npx rhinoq dev --demo
```

Demo này không cần PostgreSQL/Redis, chỉ dùng dữ liệu mô phỏng để cho thấy
progress, result và attempt lỗi. Muốn chạy Task profile PostgreSQL thật, dùng
`npx rhinoq up`.

## Đường chạy thật ngắn nhất

Trong một thư mục trống, chạy:

```powershell
mkdir rhinoq-first-run
cd rhinoq-first-run
npm init -y
npm install @rhinoq/node@0.1.0-beta.22 pg
npx rhinoq up
```

Lệnh này tạo PostgreSQL 16 disposable, áp dụng schema, tạo fixture và mở
Workbench. Chỉ các file local bị ignore được sinh ra. Dùng
`npx rhinoq up --dry-run` nếu muốn xem kế hoạch trước khi Docker khởi động.

Các bước Docker thủ công bên dưới chỉ dành cho môi trường không thể dùng
`up` hoặc cần kết nối một PostgreSQL đã có.

## Bạn cần gì?

- Node.js 22 hoặc 24;
- Docker Desktop;
- một thư mục trống.

Bạn chưa cần Redis, BullMQ, Go hoặc tài khoản cloud.

## 1. Chạy PostgreSQL thử nghiệm

PowerShell:

```powershell
docker run --name rhinoq-quickstart-db `
  -e POSTGRES_USER=rhinoq `
  -e POSTGRES_PASSWORD=rhinoq `
  -e POSTGRES_DB=rhinoq `
  -p 55432:5432 -d postgres:16-alpine
```

Kiểm tra database:

```powershell
docker exec rhinoq-quickstart-db pg_isready -U rhinoq -d rhinoq
```

Chỉ làm bước tiếp theo khi thấy `accepting connections`.

## 2. Cài RhinoQ

```powershell
mkdir rhinoq-first-run
cd rhinoq-first-run
npm init -y
npm install @rhinoq/node@0.1.0-beta.22 pg
$env:RHINOQ_DATABASE_URL='postgresql://rhinoq:rhinoq@127.0.0.1:55432/rhinoq'
npx rhinoq eval
```

Kết quả đúng phải có `PASS` cho kết nối PostgreSQL, schema Task, fixture, owner
API, Task Center và Workbench. `NOT VERIFIED` cho browser/provider/fault không
phải lỗi; quickstart không giả vờ đã kiểm chứng môi trường production.

## 3. Áp dụng vào repository hiện có

```bash
npm install @rhinoq/node@next pg
npx rhinoq setup
npx rhinoq setup --apply
```

Lần chạy đầu chỉ preview. `--apply` không ghi đè file đang có. Sau đó đọc
[Khai báo một Task](./khai-bao-task.md).
