# RhinoQ — Nâng cấp trải nghiệm sử dụng

> Bổ sung cho `RHINOQ_V2_CHIEN_LUOC.md`. Thay thế mục 3.2, 3.4 và sửa mục 7 của file đó.
> Phạm vi: **chỉ nói về việc làm người dùng nhàn hơn.** Không nhắc lại chiến lược, thị trường, hay đối thủ.
>
> **Trạng thái:** đây là DX target, không phải feature matrix. Engine hiện viết
> bằng Go; Rule SQL có tham số, Explain gate, Findings và scheduler cursor đã
> có. `scan`, `introspect`, typed Rule builder, Console, webhook và auto-enqueue
> vẫn là roadmap. Node.js hiện có producer, worker lifecycle và operator SDK
> preview trong `sdks/node`, nhưng chưa phát hành lên npm. Các ví dụ TypeScript
> về typed Rule builder bên dưới vẫn chỉ là nghiên cứu API, không phải API hiện
> có. Mọi con số thời gian trong tài liệu này là mục tiêu usability chưa được
> đo, không phải claim của sản phẩm.

---

## 1. Đo bằng gì

Ba chỉ số, và chỉ ba. Mọi quyết định DX trong file này phục vụ một trong ba.

| Chỉ số | Mục tiêu | Vì sao |
| --- | --- | --- |
| **Thời gian tới phát hiện đầu tiên** | cần đo sau khi `scan` tồn tại; mục tiêu thử nghiệm ≤ 5 phút sau khi cài CLI | quyết định người ta có thử tiếp không |
| **Thời gian tới rule thứ hai** | mục tiêu thử nghiệm < 10 phút, chưa kiểm chứng | kiểm tra liệu abstraction có thật sự giảm công sức lặp lại |
| Thời gian xử lý một finding | mục tiêu thử nghiệm < 30 giây khi Console tồn tại | quyết định họ có quay lại không |

### 1.1 Vì sao rule thứ hai mới là vạch quan trọng

Giả thuyết cần kiểm chứng là chi phí tự viết cron tăng gần tuyến tính theo số
rule, trong khi một Rule abstraction tốt tái sử dụng được lifecycle, evidence,
dedup và operator workflow. Chưa có nghiên cứu usability nào chứng minh RhinoQ
đạt các mốc thời gian cụ thể.

```
Tự làm:   mỗi rule lặp lại query + schedule + dedup + audit + thao tác xử lý
RhinoQ:   setup ban đầu + khai báo thêm rule trên cùng lifecycle dùng chung
```

Điểm hoà vốn thực tế phải được đo với người dùng thật. Toàn bộ thiết kế
onboarding dưới đây nhằm giúp họ tạo nhiều hơn một rule trong lần đánh giá đầu
tiên để kiểm tra giá trị tái sử dụng, thay vì mặc định giá trị đó đã được chứng
minh.

**Hệ quả trực tiếp:** `scan` phải sinh **2–3 rule cùng lúc**, không phải 1.

---

## 2. API khai báo Rule — ba tầng

Bản V2 mục 3.2 viết ví dụ bằng SQL thuần. **Sai.** SQL thuần làm mặc định sẽ giết onboarding: không type-safe, không autocomplete, đổi tên cột thì vỡ ở runtime, và dev dùng Prisma/Drizzle cả năm không viết SQL tay bao giờ.

### 2.1 Tầng 1 — config, mặc định. Phủ ~80% trường hợp

```ts
defineRule('order-must-provision', {
  watch:  { table: 'orders', where: { status: 'paid' } },
  expect: { job: 'provision', within: '5m', state: 'completed' },
  every:  '10m',
})
```

Không SQL. Type-safe nếu có sinh types (mục 2.5). Đổi tên cột → đỏ trong IDE, không phải đỏ lúc 3 giờ sáng.

Toán tử `where` tối thiểu, cố ý ít: `eq` (mặc định khi truyền giá trị trực tiếp), `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `isNull`, `notNull`, `and`, `or`.

```ts
where: { status: 'paid', total: { gt: 0 }, cancelledAt: { isNull: true } }
```

Không thêm toán tử nữa. Cần phức tạp hơn → tầng 2.

### 2.2 Tầng 2 — query builder, khi điều kiện phức tạp

```ts
watch: (db) => db.select({ id: orders.id, createdAt: orders.createdAt })
                 .from(orders)
                 .innerJoin(payments, eq(payments.orderId, orders.id))
                 .where(and(eq(payments.status, 'captured'), isNull(orders.provisionedAt)))
```

Nhận bất cứ thứ gì sinh ra được SQL — Drizzle, Kysely, query builder của Prisma. **Không khoá vào ORM nào.** RhinoQ chỉ cần chuỗi SQL cuối cùng + params.

### 2.3 Tầng 3 — SQL thuần, escape hatch

```ts
watch: sql`
  SELECT o.id, o.created_at
  FROM orders o
  JOIN payments p ON p.order_id = o.id
  WHERE p.status = 'captured' AND o.provisioned_at IS NULL
`
```

Cả ba tầng biên dịch về cùng một biểu diễn nội bộ. **Docs trang đầu chỉ show tầng 1** (nguyên tắc 19 — progressive disclosure phải thật).

### 2.4 Hợp đồng cứng cho tầng 3

Runner cần chèn mệnh đề của nó (baseline filter, cursor, limit), nên bọc query của user thành subquery:

```sql
SELECT * FROM ( /* SQL của user */ ) AS t
WHERE t.created_at > $baseline AND t.id > $cursor
ORDER BY t.id LIMIT 500
```

Ba ràng buộc, **validate ngay lúc `defineRule`**, không phải lúc chạy:

1. Phải trả về cột `id` và `created_at` (hoặc khai `idColumn` / `timeColumn`)
2. Không được có `LIMIT`, `ORDER BY`, hoặc dấu `;`
3. `sql` phải là **tagged template thật** — `${}` sinh ra `$1`, `$2`, không nối chuỗi

Điểm 3 không phải chi tiết nhỏ: rule thường đọc tham số từ config, và một công cụ bán bằng "an toàn" mà có lỗ SQL injection thì mất tất cả.

### 2.5 Sinh types — hướng Go được đề xuất

```
$ rhinoq introspect        # dự kiến sinh internal/rhinoqschema/schema_gen.go
```

Code sinh phải cung cấp descriptor typed cho table, column và value để lỗi tên
cột xuất hiện khi compile Go. Không dùng `.d.ts`, `postinstall`, Prisma hoặc
Drizzle làm contract mặc định của engine Go; SDK ngôn ngữ khác có thể biên dịch
về cùng Rule IR sau này.

Không có bước này thì tầng 1 chỉ là object string, không hơn gì SQL. **Đây là hạng mục mới phải thêm vào scope.**

### 2.6 Scope `'job'` mặc định khác

Invariant nghiệp vụ vốn là biểu thức số học — SQL diễn đạt tự nhiên hơn config lồng nhau nhiều:

```ts
defineRule('credit-must-balance', {
  scope: 'job',
  job: 'settle-scan-credit',
  check: sql`SELECT reserved - consumed - released = 0
             FROM credits WHERE scan_id = ${ctx.correlation.scanId}`,
  within: '2m',
})
```

**Quy tắc:** scope `table` mặc định tầng 1 · scope `job` mặc định tầng 3. Hai scope khác bản chất đủ để chấp nhận hai mặc định khác nhau. Cả hai vẫn mở được cả ba tầng.

---

## 3. Onboarding mục tiêu — roadmap, phải đo

### 3.1 Bước 1: giá trị trước khi đổi queue

```
$ rhinoq scan --db postgres://...   # planned; chưa được triển khai

  Quét 3 bảng có job trỏ vào

  ⚠  orders.status = 'paid'
     p99 ở trạng thái này: 3 phút · 47 bản ghi > 6 giờ
  ⚠  media_jobs.state = 'processing'
     p99: 90 giây · 8 bản ghi > 2 ngày
  ✓  users.status — bình thường

  → rhinoq init --from-scan     sinh 2 rule từ phát hiện trên
```

Người dùng vẫn phải cài CLI và cấp kết nối PostgreSQL read-only, nhưng không
phải đổi queue hoặc sửa application để thử bước scan. Mục tiêu là chạy được cả
trên hệ thống đang dùng BullMQ hoặc pg-boss; khả năng này chưa được phát hành.

**Ba ràng buộc bắt buộc:**

- **Chỉ quét bảng có job trỏ vào.** Quét cả database thì RhinoQ thành công cụ giám sát Postgres nói chung — lạc định vị
- **Read-only tuyệt đối.** Không tạo bảng, không ghi gì. Có cờ `--role` để dùng user chỉ có quyền đọc
- **Ngôn từ: "bất thường so với chính bảng của bạn"**, không phải "lỗi". Sẽ có false positive (bảng legacy, test data, trạng thái treo có chủ đích). Sai từ ở đây là mất niềm tin ngay lần đầu

### 3.2 Bước 2: sinh rule, không phải trang trắng

```
$ rhinoq init --from-scan

  Sẽ tạo:
    rhinoq.config.ts
    rules/order-must-provision.ts     ← từ phát hiện #1
    rules/media-must-finish.ts        ← từ phát hiện #2
    migrations/0001_rhinoq.sql

  Chưa file nào được ghi. Chạy `rhinoq init --from-scan --apply`.
```

`init` chỉ tạo plan, `--apply` mới ghi (nguyên tắc 21 — giữ nguyên).

Rule sinh ra ở **tầng 1**, đọc được, sửa được:

```ts
// rules/order-must-provision.ts — RhinoQ sinh tự động, sửa thoải mái
export default defineRule('order-must-provision', {
  watch:  { table: 'orders', where: { status: 'paid' } },
  expect: { job: 'provision', within: '5m' },   // p99 quan sát được: 3 phút
  every:  '10m',
  baseline: '2026-07-28',                        // chỉ áp cho record từ hôm nay
})
```

Comment ghi số liệu quan sát được — người dùng hiểu vì sao là `5m` chứ không phải con số bịa.

### 3.3 Bước 3: một lệnh chạy tất cả

```
$ rhinoq dev
  ✓ app        pnpm dev
  ✓ worker     2 handler
  ✓ rules      2 rule · lần chạy tới 09:41
  ✓ console    http://localhost:7070
```

(Mục 17.1 bản gốc — giữ nguyên, quan trọng hơn nó có vẻ.)

### 3.4 Người không dùng `scan`

Người cài trực tiếp cũng không được bắt đầu từ trang trắng. `rhinoq init` chạy introspect, tìm bảng có cột dạng status, và đề xuất **2–3 rule** kèm số liệu quan sát được. Cùng đầu ra, khác đường vào.

---

## 4. Findings — nơi tiết kiệm nhiều nhất

Đây là phần người tự làm hầu như không bao giờ làm tử tế. Bốn hành vi bắt buộc:

### 4.1 `baseline` mặc định bật

Bật một rule mới trên database 3 năm tuổi → 40.000 finding lịch sử → người dùng đóng tab và không quay lại.

Mặc định: rule chỉ áp cho record tạo **sau** khi rule được bật. Quét lịch sử phải chủ động:

```
$ rhinoq scan-history order-must-provision --since 2026-01-01
  → 1.284 finding lịch sử. Tạo? [y/N]
```

### 4.2 Dedup

Cùng một record lệch 10 lần = **1 finding**, `occurrence_count = 10`, `last_seen_at` cập nhật. Không alert lại.

Alert lại chỉ khi: finding đã `resolved` mà lệch trở lại (`reopened`), hoặc số lượng finding của một rule tăng bất thường (mục 5.2).

### 4.3 Bốn trạng thái, không hơn

```
open → acknowledged → resolved
  └──→ suppressed (có lý do + hạn)
```

- `resolved` **tự động** khi rule pass lại. Không bắt người dùng bấm
- `suppressed` bắt buộc có lý do và hạn — hết hạn thì mở lại, tránh việc giấu vấn đề vĩnh viễn

### 4.4 Mục tiêu xử lý trong 30 giây

Khi Console tồn tại, usability test phải kiểm tra người dùng có thể xử lý một
finding trong 30 giây hay không. Từ Console hoặc CLI, một finding cần làm được
ngay ba việc: xem timeline (mục 6), enqueue job bù, hoặc suppress kèm lý do.
Không có bước trung gian, không có form nhiều trường.

```
$ rhinoq findings --rule order-must-provision
  47 open · 3 acknowledged · 12 suppressed

$ rhinoq findings suppress f_8812 --reason "đơn test" --until 30d
```

---

## 5. Tự động hoá — "nhàn" thật sự

### 5.1 Auto-enqueue

Tính năng làm người dùng nhàn nhất trong toàn bộ sản phẩm: phát hiện thiếu job thì **tự tạo job bù**, không cần người.

Nhưng chỉ an toàn với job idempotent, nên **mặc định tắt**, và bật thì phải khai báo rõ:

```ts
onViolation: {
  enqueue: true,
  maxPerRun: 50,              // trần cứng, không tuỳ chọn
  requireIdempotency: true,   // job không có idempotency key → từ chối bật
  notifyOn: 'first',          // báo lần đầu, không báo mỗi lần
}
```

Ba lớp bảo vệ:

- `requireIdempotency` — RhinoQ kiểm lúc `defineRule`, job không khai idempotency thì báo lỗi ngay
- `maxPerRun` — rule hỏng không thể đẻ ra 10.000 job
- **Circuit breaker riêng**: nếu số finding của một rule tăng đột biến (mục 5.2), auto-enqueue **tự tắt** và chuyển sang `finding`. Sự cố lớn không được biến thành bão job

### 5.2 Phát hiện tăng đột biến

```
⚠ order-must-provision: 0.01% → 0.4% (40×) trong 2 giờ
  → auto-enqueue đã tạm dừng
  → 23 finding mới, tất cả sau 14:32
```

Không cần cấu hình ngưỡng. So với đường cơ sở của chính rule đó trong 7 ngày.

### 5.3 `rhinoq fix` — dám bấm nút

```
$ rhinoq fix order-must-provision --dry-run

  47 findings
  → enqueue 47 job 'provision'
  → 3 bỏ qua (idempotency key đã tồn tại)
  → ước tính 44 lần gọi provisioning API
  → 5 finding cũ hơn 30 ngày (legacy? xem lại)

$ rhinoq fix order-must-provision --apply --limit 10
  ✓ 10 job enqueued · audit fix_20260728_1
```

Giá trị không nằm ở code tiết kiệm được. Nằm ở việc **dám bấm**: `--dry-run` mặc định, `--limit`, audit log. Script tự viết luôn thiếu cả ba.

---

## 6. Timeline — 20 phút xuống 5 giây

Chỗ tiết kiệm lớn nhất, và không ai từng tính nó là chi phí: mỗi lần khách hàng phàn nàn, dev mò log ở ba nơi mất 20 phút.

```
$ rhinoq trace order_4821
```

```
order_4821                                       14:02:11 → 14:09:40

├─ 14:02:11  business   orders.status = 'pending'
├─ 14:02:11  intent     job#8812 'provision' enqueued (cùng transaction ✓)
├─ 14:02:40  attempt 1  worker-3   FAILED   provider-a 503
├─ 14:03:10  attempt 2  worker-1   CRASHED  lease expired
│            effect     provision-account   ⚠ uncertain
├─ 14:07:55  attempt 3  worker-2   completed 1.2s
├─ 14:08:00  rule       order-must-provision  ✓ pass
└─ 14:09:40  business   orders.status = 'active'
```

Có ở cả CLI và Console. **Ô tìm kiếm ở Console phải nhận mọi thứ**: correlation id, job id, finding id, email, số điện thoại. Người đang xử lý sự cố không nhớ mình có id loại nào.

Cột `business` ở v0.1: chỉ hiện trạng thái hiện tại + `updated_at`. Đủ dùng. Lịch sử đầy đủ chờ v0.2 khi user khai `historyTable`. **Không làm CDC, không tự tạo trigger** — quá xâm lấn.

---

## 7. Tích hợp — một webhook, không phải N integration

Mỗi integration là nợ vĩnh viễn: API đổi, auth đổi, rate limit đổi. Một người làm mà 5 integration = 5 nguồn issue không bao giờ hết. Mục 57 bản gốc đã loại "20 adapter nhà cung cấp" — logic đó áp luôn cho notification.

### 7.1 Webhook chuẩn

```ts
notify: {
  webhook: process.env.RHINOQ_WEBHOOK,
  on: ['finding.created', 'rule.spike', 'digest.weekly'],
}
```

Slack, Discord, Telegram, Teams — **đều nhận webhook**. Dán URL là xong. Cần format đẹp thì n8n/Make/Zapier làm hộ. Bạn maintain **một** thứ.

Kèm `examples/` — `slack.ts`, `discord.ts`, `telegram.ts`, mỗi file ~20 dòng. Là ví dụ copy-paste, không phải integration. Nợ kỹ thuật bằng 0.

### 7.2 Ba tích hợp thật sự đáng làm

| Tích hợp | Vì sao | Khi nào |
| --- | --- | --- |
| **OpenTelemetry** | không phải tính năng — là **điều kiện vào production stack**. Team có Datadog/Grafana sẽ hỏi câu này trước mọi câu khác. Gắn `correlation_id` vào trace → dev đang xem trace của một request thấy luôn job sinh ra từ đó → click sang timeline | **v0.1** |
| **GitHub Action cho `rhinoq explain`** | rule thiếu index → fail PR, kèm câu `CREATE INDEX` cần chạy. Ngăn rule giết database production. Chi phí rất thấp | **v0.1** |
| **Sentry hai chiều** | job fail → Sentry issue có sẵn correlation, payload, số attempt. Issue → link ngược timeline. Giá trị: dev **đã** ở trong Sentry khi có sự cố — không bắt họ nhớ mở tool mới | v0.2 |

### 7.3 Không làm

| | Vì sao |
| --- | --- |
| Jira/Linear tự tạo ticket | 90% finding không đáng thành ticket → spam → user tắt |
| PagerDuty/Opsgenie native | webhook đủ. Không tự xây routing/escalation/on-call |
| Bot chat có lệnh `/rhinoq fix` | chạy `fix` từ chat mất `--dry-run`, mất review. **Đọc thì được, sửa thì không** |
| Grafana datasource plugin | `/metrics` Prometheus đã đủ |
| App chính thức trên Zapier/n8n | webhook đã đủ |

---

## 8. Chi tiết nhỏ, tác động lớn

### 8.1 Error message năm phần + `rhinoq doctor`

Mục 17.2 bản gốc — giữ nguyên. Đây là chi tiết phân biệt tool nghiệp dư với tool chuyên nghiệp:

```
✗ Rule 'order-must-provision' bị từ chối

  Chuyện gì:  query quét tuần tự bảng orders (1.2M dòng)
  Vì sao:     rule chạy mỗi 10 phút, seq scan sẽ chiếm CPU database
  RhinoQ đã:  không kích hoạt rule. Không có gì chạy.
  Sửa:        CREATE INDEX CONCURRENTLY idx_orders_status
                ON orders (status) WHERE status = 'paid';
  Kiểm tra:   rhinoq explain order-must-provision
```

### 8.2 `rhinoq explain` chạy được ở ba nơi

Lúc `defineRule` (dev thấy ngay) · trong `rhinoq dev` (watch mode) · trong CI (chặn merge). Cùng một logic, ba điểm chạm.

### 8.3 Console: 2 màn hình, một ô tìm kiếm

**Queues** (job list, DLQ, retry) và **Findings**. Queue dashboard là parity vì
pg-boss hiện có `@pg-boss/dashboard`; business-key search, Rule evidence và
Finding lifecycle mới là khác biệt cần chứng minh.

Không làm màn hình thứ ba. Không làm dashboard biểu đồ. Không làm incident workspace.

### 8.4 Digest hàng tuần

*3 finding mới · 12 đã xử lý · rule X tăng bất thường.* Kéo người quay lại mà không cần họ nhớ. Chỉ bắn webhook.

---

## 9. Thay đổi với scope v0.1

Bổ sung vào mục 7 của `RHINOQ_V2_CHIEN_LUOC.md`:

| # | Hạng mục mới | Giai đoạn | Chi phí |
| --- | --- | --- | --- |
| 15 | `rhinoq introspect` — sinh types cho tầng 1 | 2 (tuần 6–10) | ~1 tuần |
| 16 | Rule API tầng 1 + tầng 2 (tầng 3 vốn đã có) | 2 | ~1 tuần |
| 17 | Auto-enqueue + 3 lớp bảo vệ + phát hiện spike | 2 | ~3 ngày |
| 18 | OpenTelemetry + correlation trong trace | 1 (tuần 1–5) | ~2 ngày |
| 19 | Webhook notify + 3 file `examples/` | 3 | ~2 ngày |
| 20 | GitHub Action cho `explain` | 3 | ~1 ngày |

**Tổng cộng thêm khoảng 3 tuần → 17–19 tuần.**

Ba tuần này đổi lấy vạch hoà vốn ở rule thứ 2 thay vì rule thứ 5. Đáng.

Điều chỉnh khác: `rhinoq scan` sinh **2–3 rule**, không phải 1 (mục 1.1).

---

## 10. Không làm gì để "nhàn hơn"

Bốn thứ nghe như DX nhưng thực ra làm sản phẩm tệ đi:

| | Vì sao không |
| --- | --- |
| **Rule tự động không cần khai báo** | RhinoQ đoán business logic = false positive hàng loạt = mất niềm tin vĩnh viễn. `scan` **đề xuất**, người dùng **xác nhận**. Ranh giới này không được vượt |
| **Auto-repair không giới hạn** | người dùng cần cảm giác kiểm soát. `--dry-run` mặc định không phải bất tiện, là lý do họ dám dùng |
| **Trigger/CDC tự cài vào bảng của user** | xâm lấn. Không công cụ nào được tự động thêm trigger vào database production của người khác |
| **Nhiều cách khai báo job song song** | nguyên tắc 20. Ba tầng của Rule là *một* API với ba mức chi tiết, không phải ba API |

---

## 11. Nói thật trong README

Hai câu phải có, và chúng **tăng** niềm tin chứ không giảm:

> **Nếu bạn chỉ có một thứ cần kiểm tra, đừng cài RhinoQ.** Một cron 30 dòng đúng hơn. RhinoQ bắt đầu có lãi từ rule thứ hai, thứ ba.

> **RhinoQ không tự biết business logic của bạn.** `scan` đề xuất được vài rule từ số liệu quan sát được, nhưng rule đúng thì chỉ bạn viết được.

Và không bán bằng "tiết kiệm 500 dòng code" — dev nào cũng biết 500 dòng không đáng sợ. Bán bằng câu này:

> *Cái cron bạn viết rồi ấy — nó ồn quá nên bạn tắt alert từ tháng trước, đúng không?*
