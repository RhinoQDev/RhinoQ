# Kế hoạch nâng cấp RhinoQ: hiệu năng, chống nghẽn và bảo mật

Tài liệu này gồm ba phần độc lập nhau:

1. **Vì sao `report_test.pdf` không dùng được làm bằng chứng** — và bộ đo thay thế.
2. **Bản đồ điểm ngắt mạch** — nơi hệ thống thực sự bị nghẽn khi chạy nhiều, có
   dẫn chiếu `file:dòng` và cơ chế hỏng cụ thể.
3. **Kế hoạch nâng cấp P0 → P2** — sửa cái gì, theo thứ tự nào, và điều kiện
   nghiệm thu.

Phạm vi: `sdks/node/src/postgres`, `sdks/node/src/tasks`, `internal/adapters/postgres`,
`internal/runtime`, `internal/interfaces/agent`, `cmd/*`.

**Cập nhật 2026-08-17 — đã thực hiện và đo.** Toàn bộ N1–N10 và S1–S6 đã được sửa
trên nhánh `perf/contention-remediation`, kiểm chứng trên PostgreSQL 16.14 thật
(container dùng một lần, đúng cấu hình CI). Bảng kết quả đo ở ngay dưới; phần
phân tích giữ nguyên vì nó là lý do của từng thay đổi.

| # | Đã làm | Đo được |
|---|---|---|
| N1 | Migration 015 — khoá advisory theo `(task, item)` thay khoá hàng Task cha | 8 item × 100 ms: **1748 ms → 228 ms** |
| N2 | Migration 016 — trigger `FOR EACH STATEMENT`, gộp bump version vào cùng lệnh | **8 → 4** lượt ghi/item vào hàng cha; `entityVersion` không đổi |
| N3 | Lệnh ghi trả `{version}`; bridge dùng đường rẻ | fan-out 120 item: **6,21 MB → 0,22 MB**, 1680 → 960 truy vấn |
| N4 | Migration 017 — `pg_notify` + hub `LISTEN`; poll hạ xuống 30 s | 200 client SSE: **200 q/s → 0 q/s** ở trạng thái ổn định |
| N5 | `internal/infrastructure/database` — pool cho cả ba binary + kiểm tra trong `doctor` | mặc định `max_open = max_idle`, không còn churn |
| N6 | `withTenant()` — `set_config(...,true)` trên pool dùng chung | 1 pool phục vụ nhiều tenant, kiểm chứng trên role `NOSUPERUSER NOBYPASSRLS` |
| N7 | `NextQueueRateLimitTTL` — một truy vấn cho cả subscription | worker 30 lane: **30 → 1** truy vấn mỗi vòng nhàn rỗi |
| N8 | `lock_timeout` cho transaction `onceForItem`; timeout cấp role vào checklist | chờ khoá có biên |
| N9 | `listTasksPage()` — keyset trên `(updated_at, id)` | OFFSET lặp row khi có ghi đồng thời; keyset không |
| N10 | Xô token theo từng credential + trần toàn tiến trình | một credential ồn không còn làm 429 cho credential khác |
| S1 | `OwnerFacingTaskStore` — compiler chặn bề mặt owner chạm phương thức không fence | 3 test ghim ranh giới |
| S2 | `assertTenantId()` — regex ở biên, dùng cả ở `withPostgresOption` | tenant chứa khoảng trắng bị từ chối |
| S6 | `security.yml` tách audit dependency ship (mọi mức) và toolchain (high+) | — |

Kiểm chứng: 462 test unit, 28 test integration mới/hiện có trên PostgreSQL thật,
`tests/postgres` (Go) xanh với `-shuffle=on`, `go vet`, `gofmt`, `fault:check`,
`pack:check` và ba script verify của repo đều xanh.

**Giới hạn còn lại:** các con số trên đo trên một máy, một container, không phải
dưới tải production nhiều replica. Chúng chứng minh *hướng* và *bậc* của thay đổi
(bậc hai → tuyến tính, tuyến tính → hằng số), không phải throughput tuyệt đối.
P0-0 vẫn cần chạy để có đường cong bão hoà thật.

---

## Phần 1 — Report hiện tại đo sai cái gì

Bạn đã nhận ra đúng vấn đề. Đây là phần chứng minh bằng chính mã nguồn benchmark.

### 1.1. Cột "Dùng Lib" không hề chạm cơ sở dữ liệu

`sdks/node/bench/task-benchmark.mjs` dựng một client giả:

```js
function client(read) {
  return {
    async getTask() { return read(); },   // trả object literal trong RAM
    async cancelTask() { throw new Error('unused'); },
    async getTaskResult() { throw new Error('unused'); },
  };
}
```

Vậy `task-store-newer-snapshot` = 1,719,099 ops/sec là tốc độ **so sánh một số
nguyên và gán một object trong bộ nhớ V8**. Nó không đo RhinoQ. Nó đo `if (a > b)`.

### 1.2. Cột "Không dùng Lib" là cùng một phép đo lặp lại 10 lần

Đọc lại các con số ở cột trái: 1,396 — 1,139 — 1,426 — 1,471 — 1,334 — 1,253 —
1,445 — 1,600 — 1,551 — 1,703 — 1,333 ops/sec. Tất cả đều nằm quanh 1,531
ops/sec, chính là con số mà mục 3.2 của report khai báo là kết quả chạy
`SELECT 1` hai nghìn lần.

Nghĩa là: **không có nghiệp vụ nào ở cột trái được đo cả.** "Effect Ledger claim
miss", "waitpoint state transition", "artifact lineage resolution" — cả 10 dòng
đều là độ trễ một vòng TCP tới PostgreSQL, gắn nhãn khác nhau.

### 1.3. Phép so sánh sai trục

Bảng đang đặt cạnh nhau:

| Cột trái | Cột phải |
|---|---|
| Một vòng mạng TCP + parse + planner + executor | Một lời gọi hàm JavaScript |
| ~650,000 ns | ~100 ns |

Tỉ số 6,500× đó là **tỉ số giữa mạng và RAM**. Nó tồn tại với mọi thư viện, mọi
ngôn ngữ, mọi bài toán. Nó không nói gì về RhinoQ.

Tệ hơn: RhinoQ **cũng** phải đi qua PostgreSQL cho đúng những nghiệp vụ đó.
`rhinoq_task.claim_item_effect` là một hàm PL/pgSQL
([`task-schema.ts:837`](../../sdks/node/src/postgres/task-schema.ts)). Nó không
chạy trong RAM của Node. Bảng đang so RhinoQ-phiên-bản-giả-lập với
RhinoQ-phiên-bản-thật và gọi phiên bản thật là "không dùng lib".

### 1.4. Một tuyên bố mâu thuẫn với chính implementation

Report viết: *"Cơ chế SSE tối ưu tích hợp sẵn, chỉ trigger update khi có thay đổi
thực tế ở DB, giảm tải 95% cho DB."*

Mã nguồn thực tế, [`sdks/node/src/tasks/sse.ts:20`](../../sdks/node/src/tasks/sse.ts):

```ts
const pollMs = bounded(options.pollIntervalMs ?? 1_000, 250, 60_000, 'stream poll interval');
while (!signal.aborted) {
  const task = await source.getTaskSummaryForOwner(taskId, ownerId, tenantId);
  ...
  if (isTerminal(task.state) || !(await wait(pollMs, signal))) return;
}
```

Đây **là** polling, 1 giây một lần, **cho mỗi kết nối**. Không có `LISTEN/NOTIFY`
ở bất kỳ đâu trong repo. Cái được tiết kiệm là băng thông từ server xuống trình
duyệt. Tải lên PostgreSQL thì ngược lại: với `maxConnections` mặc định 1,000
([`http.ts:126`](../../sdks/node/src/tasks/http.ts)), 1,000 client mở stream = 1,000
truy vấn mỗi giây, mỗi truy vấn có một `LEFT JOIN LATERAL` đếm toàn bộ execution
của task ([`task-client.ts:132`](../../sdks/node/src/postgres/task-client.ts)).

Con số "giảm 95%" phải rút khỏi mọi tài liệu cho tới khi có `LISTEN/NOTIFY` thật
(mục P0-4 bên dưới) và có phép đo kèm theo.

### 1.5. Thiếu đường cơ sở duy nhất có ý nghĩa

Câu hỏi của người sắp chọn thư viện không phải "RhinoQ so với tự viết tay thì sao"
mà là **"RhinoQ so với thứ tôi đang định dùng thì sao"**. Đường cơ sở phải là:

| Đường cơ sở | Vì sao cần |
|---|---|
| **BullMQ** thuần | Đối thủ trực tiếp nhất trong hệ Node; RhinoQ cũng tích hợp với nó |
| **pg-boss**, **graphile-worker** | Cùng mô hình hàng đợi-trên-PostgreSQL |
| **River** (Go) | Cùng mô hình, cùng ngôn ngữ lõi |
| **Temporal**, **Trigger.dev**, **Inngest** | Cùng bài toán durable execution / waitpoint |

Không có đường cơ sở nào trong số này xuất hiện trong report.

### 1.6. Đo sai đại lượng

`ops/sec` của một hàm thuần là đại lượng vô nghĩa với hệ thống hàng đợi. Đại lượng
đúng:

| Đại lượng | Định nghĩa |
|---|---|
| **Throughput end-to-end** | task/giây đi trọn `enqueue → claim → chạy → settle`, tải bão hoà |
| **Độ trễ p50 / p95 / p99** | phân vị, dưới đồng thời; giá trị trung bình che mất chính hiện tượng cần tìm |
| **Đường cong bão hoà** | throughput theo số worker: tìm điểm nó *ngừng tăng* — đó mới là điểm ngắt mạch |
| **Áp lực khoá** | `pg_stat_activity` số phiên chờ `Lock`, `pg_locks` chiều dài hàng chờ |
| **Chi phí mỗi task** | truy vấn/task, byte truyền/task, kết nối/worker |

Ba đại lượng cuối là thứ trả lời được câu "chạy nhiều có nghẽn không". Report hiện
tại không có đại lượng nào trong năm.

### 1.7. Phép đo đúng đã tồn tại sẵn trong repo — report chỉ không dùng nó

Đây là chi tiết đáng chú ý nhất của toàn bộ việc rà soát.

`sdks/node/bench/postgres-benchmark.mjs` đã làm gần hết những gì §1.6 yêu cầu:

| Yêu cầu | `postgres-benchmark.mjs` | `task-benchmark.mjs` (report dùng) |
|---|---|---|
| Chạy trên PostgreSQL thật | ✅ | ❌ client giả |
| Quét mức đồng thời | ✅ 1, 8, 16, 32 | ❌ |
| Kịch bản fan-out | ✅ 10, 100, 500 item | ❌ |
| p50 / p95 / p99 | ✅ | ❌ chỉ ops/sec |
| Ghi phiên bản PostgreSQL | ✅ | ❌ |

Nó thậm chí đã đặt tên cho đúng vấn đề N3 bên dưới:
`postgres-fanout-reserve-with-growing-snapshot`. Ai đó đã biết snapshot phình to
theo fan-out là một chi phí cần theo dõi.

Report chọn `task-benchmark.mjs` — file duy nhất trong repo không chạm cơ sở dữ
liệu — rồi trình bày nó như số liệu của sản phẩm.

**Ba khoảng trống còn lại** của bộ đo đúng, chính là nội dung P0-0:

1. Chỉ chạy khi `schedule` hoặc `workflow_dispatch`
   ([`ci.yml:91`](../../.github/workflows/ci.yml)) — không có đường xu hướng theo
   pull request, nên hồi quy hiệu năng lọt qua mà không ai thấy.
2. Fan-out dừng ở 500 item. Các hiệu ứng bậc hai ở N2/N3 chỉ lộ rõ từ vài nghìn.
3. Không có đường cơ sở thư viện ngoài, và không thu `pg_stat_activity` /
   `pg_locks` trong lúc chạy — nên khi throughput phẳng ra, số liệu không nói được
   **vì sao**.

### 1.8. Những gì report nói đúng và nên giữ

Không phải mọi thứ đều sai. Phần **fault-test Stripe** (mục 4.1) là bằng chứng
đúng loại: nó chứng minh một **tính chất đúng đắn** (không tính tiền hai lần khi
worker chết giữa chừng) bằng cách dựng lại đúng tình huống hỏng. Đó là thế mạnh
thật của RhinoQ và nó không cần một con số ops/sec nào để thuyết phục.

**Đề nghị định vị lại:** RhinoQ không cạnh tranh bằng tốc độ. Nó cạnh tranh bằng
việc *một trạng thái xanh không được phép nói dối*. Bán tốc độ bằng số liệu vay
mượn sẽ làm hỏng chính luận điểm đó ngay lần đầu có người chạy lại benchmark.

---

## Phần 2 — Bản đồ điểm ngắt mạch

Xếp theo mức độ: điểm càng trên càng làm hệ thống dừng sớm hơn khi tăng tải.

### 🔴 N1 — `onceForItem` giữ khoá hàng Task cha suốt callback nghiệp vụ

**Đây là điểm ngắt mạch nghiêm trọng nhất trong toàn bộ mã nguồn.**

Chuỗi sự việc, [`task-client.ts:466–528`](../../sdks/node/src/postgres/task-client.ts):

```ts
await connection.query('BEGIN', []);
await connection.query(`SELECT rhinoq_task.claim_item_effect($1, $2) AS claimed`, ...);
// ...
value = await operation(connection);      // ← callback nghiệp vụ của người dùng
await connection.query('COMMIT', []);
```

Và bên trong `claim_item_effect`, [`task-schema.ts:860–870`](../../sdks/node/src/postgres/task-schema.ts):

```sql
-- Lock the parent before inspecting all attempts.
PERFORM 1 FROM rhinoq_task.tasks WHERE id = v_task_id FOR UPDATE;
```

`FOR UPDATE` giữ khoá **cho tới hết transaction**. Transaction chỉ kết thúc sau
`operation(connection)`. Nên:

- Toàn bộ N item của **cùng một Task** bị tuần tự hoá hoàn toàn. Fan-out mất hết
  ý nghĩa: 100 worker chạy song song sẽ xếp hàng một-một trên một hàng dữ liệu.
- Khoá bị giữ qua thời gian chạy code tuỳ ý của người dùng — thường có gọi HTTP
  ra ngoài (Stripe, S3). Một provider chậm 3 giây sẽ đóng băng cả batch 3 giây
  **mỗi item**.
- Không có `lock_timeout`, nên các item còn lại chờ vô hạn, mỗi item chiếm một
  connection của pool. Pool cạn → toàn ứng dụng, kể cả request HTTP không liên
  quan, đứng.

**Thời gian hoàn thành batch ≈ N × (thời gian nghiệp vụ mỗi item).** Đúng bằng
chạy tuần tự, bất kể đặt concurrency bao nhiêu.

**Nghịch lý:** đây là tính năng được quảng cáo là "xử lý hàng loạt lớn — tự động
quản lý tiến độ, dùng DB transaction locks an toàn và tối ưu" trong report.

**Cách sửa** — tách quyết định khỏi công việc. Khoá chỉ cần bảo vệ mảng
`effect_keys` của item đó, không cần bảo vệ Task cha:

```sql
-- Thay PERFORM ... tasks FOR UPDATE bằng một khoá hẹp theo item.
-- Hai attempt của cùng một item không bao giờ chạy song song một cách hợp lệ,
-- nên khoá theo (task_id, item_key) là đủ chặt, và hai item khác nhau
-- không còn đụng nhau.
PERFORM pg_advisory_xact_lock(
  hashtextextended(v_task_id || ':' || v_item_key, 0)
);
```

Kèm ràng buộc: `claim_item_effect` **commit ngay**, callback nghiệp vụ chạy trong
transaction riêng, và việc "đã claim nhưng nghiệp vụ hỏng" được xử lý bằng
compensation qua Effect Ledger — đúng mô hình mà `docs/failure-semantics.md` đã mô
tả cho ProviderOperation.

> Nếu quyết định giữ nguyên ngữ nghĩa "cùng một transaction", thì tối thiểu phải:
> (a) đổi sang advisory lock theo item như trên, (b) đặt `lock_timeout` trước
> `BEGIN`, (c) ghi vào tài liệu rằng callback **không được** gọi mạng.

---

### 🔴 N2 — Mọi thay đổi Execution đều ghi vào hàng Task cha (hot row)

Mỗi hàm chuyển trạng thái Execution kết thúc bằng
([`task-schema.ts:1321`](../../sdks/node/src/postgres/task-schema.ts) và 5 chỗ khác):

```sql
UPDATE rhinoq_task.tasks
SET version = version + 1, updated_at = clock_timestamp()
WHERE id = v_execution.task_id;
```

Cộng thêm trigger `update_execution_counts`
([`task-schema.ts:587`](../../sdks/node/src/postgres/task-schema.ts)) — cũng
`UPDATE rhinoq_task.tasks` — chạy `FOR EACH ROW`.

Hệ quả với một Task fan-out N item, mỗi item đi qua `pending_dispatch → dispatched
→ running → succeeded`:

| Hiện tượng | Quy mô |
|---|---|
| Số lần ghi vào **một** hàng | ~8N (4 transition × 2 lệnh UPDATE) |
| Tuple chết sinh ra trên hàng đó | ~8N |
| Chuỗi HOT-update phải duyệt khi đọc | dài dần trong suốt batch |
| Xung đột khoá hàng | mọi item, mọi lúc |

Với N = 10,000, một hàng dữ liệu nhận 80,000 lượt ghi. Autovacuum không theo kịp
một hàng nóng như vậy; đọc hàng đó chậm dần trong chính lúc batch đang chạy.

Đồng thời `version` là token của optimistic concurrency. Nó nhảy ~8N lần trong
batch, nên **mọi lệnh cấp Task** (`reportTaskProgress`, `transitionTask`) do người
dùng gọi sẽ gần như luôn thua fence và ném `RHINOQ_VERSION_CONFLICT`. Retry cũng
không hội tụ, vì lần đọc lại đã lại cũ.

*(Các comment trong `settle_items` và `report_progress` cho thấy vấn đề này đã
được nhận ra ở phạm vi hẹp và xử lý cục bộ. Cần xử lý ở gốc.)*

**Cách sửa:**

1. **Tách version thành hai trục.** `tasks.version` chỉ tăng khi *thuộc tính của
   Task* đổi (state, progress, result). Tổng hợp con (`execution_*`) chuyển sang
   một cột `child_revision bigint` riêng, không nằm trong fence.
2. **Bỏ trigger `FOR EACH ROW`, chuyển sang `FOR EACH STATEMENT`** với bảng
   chuyển tiếp:

   ```sql
   CREATE TRIGGER executions_update_counts
   AFTER UPDATE OF state ON rhinoq_task.executions
   REFERENCING NEW TABLE AS changed OLD TABLE AS previous
   FOR EACH STATEMENT EXECUTE FUNCTION rhinoq_task.update_execution_counts();
   ```

   Một lệnh cập nhật 500 item khi đó chạm hàng cha **một lần** thay vì 500 lần.
3. **Hoặc, phương án triệt để hơn:** bỏ hẳn cột đếm, tính đếm bằng
   `LEFT JOIN LATERAL` lúc đọc (`SUMMARY_SQL` vốn đã làm vậy) và đánh index
   `(task_id, state) WHERE superseded_at IS NULL`. Ghi trở nên rẻ hoàn toàn, đọc
   đắt hơn một chút và có thể đệm.

---

### 🔴 N3 — Mọi lệnh ghi đều trả về snapshot đầy đủ: O(N²)

`SNAPSHOT_SQL` ([`task-client.ts:158`](../../sdks/node/src/postgres/task-client.ts))
gom **toàn bộ** execution của Task vào một mảng `jsonb`:

```sql
LEFT JOIN rhinoq_task.executions AS e ON e.task_id = t.id
```

Không lọc `superseded_at`, không `LIMIT`. Mỗi lần retry lại thêm một hàng vào mảng
này vĩnh viễn.

Và `getTask()` được gọi ở **15 chỗ** ngay sau khi ghi — `createTask`,
`bindTaskExecution`, `transitionTaskExecution`, `retryTaskExecution`,
`attachExecutionResult`, …

Kết quả với fan-out N item: N lệnh ghi × snapshot cỡ N = **O(N²) byte** phải
serialize ở PostgreSQL, truyền qua socket, và `JSON.parse` ở Node.

Đây chính là chỗ report vô tình đo đúng: `json-parse-large-snapshot` chỉ đạt
43,647 ops/sec (~23 µs/lần) — chậm hơn mọi phép đo khác vài bậc. Chỉ có điều
report trình bày nó như một nhược điểm nhỏ 1%, trong khi thực tế sản phẩm đang
kích hoạt nó **N lần mỗi batch**.

Với N = 5,000 và mỗi execution ~200 byte, một batch phải chuyển ~5 GB dữ liệu
JSON — cho một việc mà người gọi thường chỉ cần biết `version` mới.

**Cách sửa:**

1. Lệnh ghi trả về **kết quả của chính lệnh đó**, không trả snapshot. Hàm SQL đã
   `RETURNING version` sẵn — chỉ cần đừng vứt đi:

   ```ts
   async transitionTaskExecution(id, expected, target, reason): Promise<{ version: number }> {
     const result = await this.execute<{ version: string }>(
       `SELECT rhinoq_task.transition_execution($1,$2,$3,$4) AS version`,
       [id, expected, target, reason],
     );
     return { version: Number(result.rows[0].version) };
   }
   ```

   Giữ hàm cũ trả snapshot dưới tên `*WithSnapshot` cho tới khi hết beta.
2. `SNAPSHOT_SQL` thêm `AND e.superseded_at IS NULL` và **phân trang execution**
   (`?executions.limit`, `?executions.after`). Một Task 100,000 item không thể
   trả về trong một response.
3. Mặc định `getTask()` trả `TaskSummary` (đã có sẵn, `SUMMARY_SQL`); ai cần danh
   sách item phải hỏi riêng.

---

### 🟠 N4 — SSE là polling; không có `LISTEN/NOTIFY`

Đã phân tích ở §1.4. Bổ sung về mặt tài nguyên:

- Mỗi stream giữ một truy vấn mỗi giây trong suốt vòng đời kết nối.
- `taskListEventResponse` mỗi 2 giây chạy `LIST_SNAPSHOTS_SQL`, vốn có
  `jsonb_agg` toàn bộ execution cho **mỗi** task trong trang.
- `maxConnections` mặc định 1,000, nhưng số connection PostgreSQL thì không được
  giới hạn tương ứng ở đâu cả.

**Cách sửa** (P0-4): thêm `pg_notify` vào cuối các hàm chuyển trạng thái, một
connection `LISTEN` dùng chung cho cả tiến trình, fan-out trong bộ nhớ ra các
stream. Poll giữ lại làm mạng an toàn nhưng hạ xuống 30 giây.

```sql
-- cuối mỗi hàm transition: payload chỉ mang id + version, không mang dữ liệu
PERFORM pg_notify('rhinoq_task', json_build_object(
  'taskId', v_task_id, 'version', v_task_version, 'tenantId', v_tenant
)::text);
```

Lưu ý: payload `NOTIFY` giới hạn 8,000 byte và **không** đi qua RLS — chỉ gửi
định danh, client vẫn phải đọc lại qua đường có kiểm tra quyền.

---

### 🟠 N5 — Không giới hạn connection pool ở phía Go

Cả ba binary mở database rồi dùng luôn:

- [`cmd/rhinoq/database.go:27`](../../cmd/rhinoq/database.go)
- [`cmd/rhinoq-agent/main.go:235`](../../cmd/rhinoq-agent/main.go)
- [`cmd/rhinoq-worker/main.go:29`](../../cmd/rhinoq-worker/main.go)

Không có `SetMaxOpenConns`, `SetMaxIdleConns`, `SetConnMaxLifetime` ở bất kỳ đâu
trong repo. Mặc định của `database/sql`:

| Tham số | Mặc định | Hệ quả |
|---|---|---|
| `MaxOpenConns` | **không giới hạn** | Đủ worker là chạm `max_connections`; PostgreSQL trả `too many clients already` cho *mọi* client, kể cả tiến trình khác dùng chung DB |
| `MaxIdleConns` | **2** | Vượt quá 2 là đóng connection ngay; burst → bắt tay TCP + TLS + xác thực lại liên tục |
| `ConnMaxLifetime` | vô hạn | Connection không xoay vòng qua được pooler/failover |

`MaxIdleConns = 2` đặc biệt đáng chú ý: nó biến mỗi truy vấn vượt ngưỡng thành một
lần kết nối mới. Chi phí bắt tay có thể **vượt xa** chi phí truy vấn — rất có thể
là một phần đáng kể của con số 0.65 ms mà report gọi là "giới hạn vật lý bắt buộc".

**Cách sửa** — một hàm dùng chung, cấu hình qua biến môi trường:

```go
func tunePool(db *sql.DB, getenv func(string) string) {
	maxOpen := intEnv(getenv, "RHINOQ_DB_MAX_OPEN_CONNS", 4*runtime.GOMAXPROCS(0))
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxOpen)              // idle == open: tránh churn
	db.SetConnMaxIdleTime(durEnv(getenv, "RHINOQ_DB_CONN_MAX_IDLE", 5*time.Minute))
	db.SetConnMaxLifetime(durEnv(getenv, "RHINOQ_DB_CONN_MAX_LIFETIME", 30*time.Minute))
}
```

Và bổ sung vào `rhinoq doctor` một cảnh báo khi
`tổng MaxOpenConns của các tiến trình > max_connections × 0.8`.

---

### 🟠 N6 — Đa khách hàng: tenant gắn ở connection string ⇒ mỗi tenant một pool

Tenant được truyền bằng tham số khởi động của connection
(commit `90a6936`, [`cli/database-config.ts`](../../sdks/node/src/cli/database-config.ts)):

```js
url.searchParams.set('options', `-c rhinoq.tenant_id=${tenantId}`);
```

Đây là **thuộc tính của kết nối**, không phải của request. Nên một tiến trình phục
vụ 50 tenant cần 50 pool. Với `max: 10` mỗi pool là 500 connection từ một tiến
trình — trong khi PostgreSQL mặc định `max_connections = 100`.

Thiết kế RLS thì đúng và được kiểm chứng lúc chạy
([`tenant_isolation.go`](../../internal/adapters/postgres/tenant_isolation.go) là
một điểm mạnh thật: nó kiểm tra `rolsuper`/`rolbypassrls` chứ không tin vào file
migration). Vấn đề nằm ở **cách gắn tenant**, không ở RLS.

**Cách sửa** — chuyển sang gắn theo transaction, một pool dùng chung:

```ts
async withTenant<T>(tenantId: string, work: (c: SqlConnection) => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(tenantId)) {
    throw new TypeError('RHINOQ_INVALID_TENANT_ID');
  }
  const connection = await this.pool.connect();
  try {
    await connection.query('BEGIN', []);
    // set_config(..., true) = SET LOCAL: tự hết hiệu lực khi transaction kết thúc,
    // nên connection trả về pool không mang theo tenant của người trước.
    await connection.query(`SELECT set_config('rhinoq.tenant_id', $1, true)`, [tenantId]);
    const value = await work(connection);
    await connection.query('COMMIT', []);
    return value;
  } catch (error) {
    await connection.query('ROLLBACK', []).catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
```

Việc kiểm tra biểu thức chính quy ở trên **là bắt buộc**, kể cả sau khi chuyển
sang `set_config`. Ở dạng connection-string hiện tại, một `tenantId` chứa dấu
cách sẽ chèn thêm được tham số `-c` khác vào phiên PostgreSQL. Chuỗi hiện đi qua
`URL.searchParams` nên được mã hoá, nhưng ràng buộc này không được phát biểu ở
đâu và một đường gọi khác có thể bỏ qua nó.

---

### 🟡 N7 — Vòng lặp nhàn rỗi của worker nhân truy vấn theo số lane

[`internal/runtime/worker/worker.go:318`](../../internal/runtime/worker/worker.go):

```go
func (w *Worker) idleWait(ctx context.Context, backoff time.Duration) time.Duration {
	for _, name := range w.handlers.QueueNames() {
		ttl, err := w.store.QueueRateLimitTTL(ctx, name, now)   // ← một query mỗi lane
```

Chạy **mỗi vòng nhàn rỗi**, **mỗi lane**. Với `pollIntervalMs` khởi điểm 100 ms và
30 lane: 300 truy vấn/giây từ **một** worker **không làm gì cả**. 20 worker = 6,000
truy vấn/giây tải nền thuần tuý.

**Cách sửa:** gộp thành một truy vấn trả về TTL nhỏ nhất của tất cả lane, và đệm
kết quả trong khoảng backoff hiện tại.

```sql
SELECT min(...) FROM rhinoq_queue_controls WHERE queue_name = ANY($1)
```

---

### 🟡 N8 — Không có `lock_timeout` / `statement_timeout` trên đường ghi chính

`set_config('statement_timeout', …)` chỉ xuất hiện ở
[`rule_evaluator.go:86`](../../internal/adapters/postgres/rule_evaluator.go) và
`rule_explainer.go:66` — tức là chỉ cho SQL do operator viết.

Toàn bộ đường ghi Task/Job không có giới hạn nào. Kết hợp với N1 và N2, một
transaction kẹt sẽ kéo theo hàng chờ vô hạn phía sau, mỗi phần tử chiếm một
connection. Đây là cơ chế biến một chỗ chậm thành một sự cố toàn hệ thống.

**Cách sửa:** đặt mặc định ở tầng vai trò database, không rải rác trong mã:

```sql
ALTER ROLE rhinoq_app SET lock_timeout = '3s';
ALTER ROLE rhinoq_app SET statement_timeout = '30s';
ALTER ROLE rhinoq_app SET idle_in_transaction_session_timeout = '60s';
```

`idle_in_transaction_session_timeout` là cái quan trọng nhất trong ba: nó là thứ
duy nhất dọn được một transaction bị treo vì tiến trình client chết giữa chừng
trong khi đang giữ khoá hàng Task.

---

### 🟡 N9 — Phân trang bằng `OFFSET`

`LIST_SNAPSHOTS_SQL` ([`task-client.ts:184`](../../sdks/node/src/postgres/task-client.ts)):

```sql
ORDER BY updated_at DESC, id LIMIT $3 OFFSET $4
```

PostgreSQL phải duyệt và loại bỏ đủ `OFFSET` hàng trước khi trả kết quả. Trang thứ
1,000 tốn gấp 1,000 lần trang đầu. Và vì được gọi trong vòng lặp SSE mỗi 2 giây,
chi phí này lặp lại liên tục.

**Cách sửa:** keyset pagination trên khoá đã có sẵn trong `ORDER BY`:

```sql
WHERE (updated_at, id) < ($4::timestamptz, $5::text)
ORDER BY updated_at DESC, id DESC LIMIT $3
```

---

### 🟡 N10 — Rate limiter toàn cục, một xô, một mutex

[`internal/interfaces/agent/server.go:508`](../../internal/interfaces/agent/server.go):

```go
type requestLimiter struct {
	mu sync.Mutex
	rate, tokens, burst float64
	last time.Time
}
```

Một instance duy nhất cho toàn bộ tiến trình. Ba hệ quả:

1. **Không có công bằng giữa tenant.** Một tenant polling mạnh làm cạn xô của tất
   cả tenant còn lại.
2. **Không hoạt động khi nhiều replica.** 5 replica = 5× hạn mức thật. *(Mã nguồn
   đã ghi nhận điều này ở dòng 52 — đây là ghi lại thành hạng mục có kế hoạch,
   không phải phát hiện mới.)*
3. **Mutex toàn cục trên mọi request.** Ở throughput cao, chính nó là điểm tuần
   tự hoá.

**Cách sửa:** xô theo `(tenantID, ownerID)` trong một map có sharding, dọn định
kỳ; hạn mức toàn cục giữ lại làm trần cứng. Hạn mức phân tán thì đặt ở tầng
edge/gateway, không nhét vào tiến trình ứng dụng.

---

### Bảng tổng hợp

| # | Điểm nghẽn | Vị trí | Kiểu hỏng | Ưu tiên |
|---|---|---|---|---|
| N1 | Khoá Task cha giữ suốt callback | `task-client.ts:466`, `task-schema.ts:837` | Tuần tự hoá + cạn pool | **P0** |
| N2 | Hot row `tasks.version` | `task-schema.ts:587,1321…` | Bloat + bão version conflict | **P0** |
| N3 | Snapshot O(N) sau mọi lệnh ghi | `task-client.ts:158` + 15 chỗ gọi | O(N²) băng thông/CPU | **P0** |
| N4 | SSE polling, không NOTIFY | `tasks/sse.ts:20`, `tasks/http.ts:126` | Tải DB tuyến tính theo số client | **P0** |
| N5 | Pool Go không giới hạn | `cmd/*/…` | `too many clients` + churn kết nối | **P0** |
| N6 | Tenant gắn ở connection | `cli/database-config.ts` | Bùng nổ pool khi đa tenant | **P1** |
| N7 | `idleWait` × số lane | `runtime/worker/worker.go:318` | Tải nền vô ích | **P1** |
| N8 | Thiếu lock/statement timeout | toàn cục | Sự cố lan rộng | **P1** |
| N9 | Phân trang `OFFSET` | `task-client.ts:184` | Chậm dần theo độ sâu | **P2** |
| N10 | Rate limiter một xô | `agent/server.go:508` | Bất công + không đa replica | **P2** |

---

## Phần 3 — Bảo mật

### Những thứ đang làm đúng

Cần ghi nhận, vì đây là phần trên mức trung bình so với phần lớn dự án cùng quy mô:

| Điểm | Vị trí |
|---|---|
| RLS `FORCE` + **kiểm chứng lúc chạy** thay vì tin file migration | `tenant_isolation.go:77` |
| Phát hiện role `SUPERUSER`/`BYPASSRLS` và từ chối khởi động | `tenant_isolation.go:124` |
| Token so sánh bằng `subtle.ConstantTimeCompare` trên hash SHA-256 | `agent/server.go:142` |
| Từ chối token operator trùng token task | `agent/server.go:143` |
| Workbench chỉ bind `127.0.0.1`, HTML nhúng trong binary | `cmd/rhinoq/workbench.go:94` |
| SQL của Rule chạy trong transaction read-only + `statement_timeout` + `LIMIT` cứng | `rule_evaluator.go:78–92` |
| Kiểm tra quyền lại ở phía server, không tin việc UI ẩn nút | `ARCHITECTURE.md §1` |
| Bảng chéo tenant được kiểm tra bằng trigger ở tầng DB | `task-schema.ts:2126` |

### Những chỗ cần vá

**S1 — `getTaskExecution` không có hàng rào tenant.**
[`task-client.ts:~707`](../../sdks/node/src/postgres/task-client.ts) —
`SELECT * FROM rhinoq_task.executions WHERE id = $1`, không có `tenant_id`, không
có `owner_id`. Comment ngay trên nó đã cảnh báo *"must not be mounted as an
owner-facing endpoint"*, nhưng comment không phải là ràng buộc. Nếu `execution_id`
đoán được hoặc rò rỉ, và ai đó mount nhầm, đây là lỗ IDOR.

*Vá:* tách các phương thức không-fence sang một interface riêng
(`RuntimeTaskClient`) mà lớp HTTP không nhận được, cộng một quy tắc lint chặn
`interfaces/` import chúng. Sau khi có N6, RLS cũng sẽ chặn ở tầng DB — nhưng chỉ
khi tenant được gắn cho từng transaction.

**S2 — Không có ràng buộc định dạng `tenantId`.** Xem N6. Cần regex ở biên, và
một test khẳng định `tenant id` chứa dấu cách bị từ chối.

**S3 — SSE là kênh khuếch đại DoS.** 1 kết nối HTTP rẻ tiền = 1 truy vấn/giây
vĩnh viễn. `maxConnections: 1000` giới hạn số stream nhưng không giới hạn tải DB
sinh ra. Cần: hạn mức stream **theo tenant**, và sau N4 thì tải DB không còn tỉ lệ
với số client nữa.

**S4 — Không có `statement_timeout` trên đường chính.** Xem N8. Một truy vấn nặng
do người dùng kích hoạt hiện chạy đến hết.

**S5 — Rate limit không phân tán, không theo tenant.** Xem N10.

**S6 — Chưa có bằng chứng quét phụ thuộc.** Có `.github/workflows/security.yml`;
cần khẳng định nó chạy `govulncheck` (Go) **và** `npm audit --omit=dev` (SDK
Node), và chặn merge khi có CVE mức cao.

---

## Phần 4 — Kế hoạch nâng cấp

Nguyên tắc: **không sửa gì trước khi có phép đo bắt được lỗi đó.** Nếu không, các
mục P0 chỉ là ý kiến, và không có cách nào chứng minh chúng có tác dụng.

### P0-0 — Mở rộng bộ đo đã có (làm trước tiên)

Không viết mới. `bench/postgres-benchmark.mjs` đã đúng nền tảng (§1.7); chỉ cần bịt
ba khoảng trống:

1. **Nâng trần fan-out** lên `10, 100, 500, 2000, 10000`. Đây là dải mà N2 và N3
   chuyển từ "chậm hơn một chút" sang "không chạy nổi".
2. **Thu số liệu khoá trong lúc chạy.** Một goroutine/interval lấy mẫu mỗi 250 ms:

   ```sql
   SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')      AS waiting_on_lock,
          count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn,
          max(extract(epoch from (clock_timestamp() - xact_start))) AS longest_txn_s
   FROM pg_stat_activity WHERE datname = current_database();
   ```

   Đưa `waiting_on_lock` vào JSON kết quả. Đây là đại lượng biến "throughput
   phẳng" thành "throughput phẳng **vì** đang chờ khoá hàng cha".
3. **Thêm đường cơ sở ngoài.** Tối thiểu một: BullMQ thuần cho cùng fan-out. Đặt
   ở `bench/baseline-bullmq.mjs`, cùng định dạng JSON đầu ra.
4. **Chạy trên pull request** với cấu hình rút gọn (fan-out 100/500, đồng thời
   1/8) và so với ngưỡng đã chốt. Cấu hình đầy đủ vẫn giữ ở lịch nightly.

**Nghiệm thu:** đường cong throughput-theo-đồng-thời cho fan-out N=2000 phải cho
thấy rõ điểm bão hoà, và `waiting_on_lock` phải giải thích được nó. Nếu đường cong
phẳng ngay từ mức đồng thời 2 trong khi `waiting_on_lock` tăng theo N, thì N1 đã
được chứng minh bằng số — và mọi mục P0 còn lại có cơ sở định lượng để nghiệm thu.

### P0-1 — Gỡ khoá Task cha khỏi `onceForItem` *(N1)*

- Đổi sang `pg_advisory_xact_lock` theo `(task_id, item_key)`.
- Đặt `lock_timeout` trước `BEGIN`.
- Test: 200 item song song, callback ngủ 100 ms mỗi item. Trước khi sửa phải mất
  ~20 s; sau khi sửa phải xấp xỉ `100 ms × 200 / concurrency`.
- Test hồi quy: hai attempt của **cùng** item vẫn chỉ được claim một lần.

### P0-2 — Bỏ ghi hàng cha khỏi đường nóng *(N2)*

- Thêm `tasks.child_revision`; `execution_*` và các lần bump do con gây ra chuyển
  sang cột này.
- Trigger chuyển sang `FOR EACH STATEMENT` với transition table.
- Migration theo expand → migrate → contract; worker cũ và mới phải chạy song
  song được (`ARCHITECTURE.md §8.5`).
- Test: `pg_stat_user_tables.n_dead_tup` của `rhinoq_task.tasks` sau một batch
  10,000 item phải giảm ít nhất một bậc so với trước.

### P0-3 — Lệnh ghi thôi trả snapshot *(N3)*

- Các phương thức ghi trả `{ version }`; bản trả snapshot đổi tên `*WithSnapshot`,
  đánh dấu deprecated.
- `SNAPSHOT_SQL` thêm `AND e.superseded_at IS NULL` + phân trang execution.
- Test: tổng byte nhận từ PostgreSQL cho batch N=1000 phải giảm từ bậc N² xuống
  bậc N.

### P0-4 — `LISTEN/NOTIFY` cho realtime *(N4)*

- `pg_notify` ở cuối các hàm transition, payload chỉ gồm `{taskId, version, tenantId}`.
- Một connection `LISTEN` cho mỗi tiến trình, fan-out trong bộ nhớ.
- Poll hạ xuống 30 s, giữ vai trò mạng an toàn.
- Test: 500 kết nối SSE đồng thời; số truy vấn/giây tới PostgreSQL phải **không**
  tỉ lệ với số kết nối. Đây là phép đo hợp lệ hoá tuyên bố "giảm tải" — và chỉ khi
  đó tuyên bố mới được viết vào tài liệu, kèm con số thật đo được.

### P0-5 — Cấu hình pool ở phía Go *(N5)*

- Hàm `tunePool` dùng chung cho cả ba binary.
- `rhinoq doctor` cảnh báo khi tổng pool vượt 80% `max_connections`.
- Ghi vào `docs/production-checklist.md`.

### P1 — Sau khi P0 đã có số đo

| Mục | Nội dung |
|---|---|
| P1-1 *(N6, S1, S2)* | Tenant gắn theo transaction + validate + tách `RuntimeTaskClient` + lint chặn import |
| P1-2 *(N8, S4)* | `lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout` ở cấp role |
| P1-3 *(N7)* | Gộp truy vấn `QueueRateLimitTTL` |
| P1-4 *(S6)* | `govulncheck` + `npm audit` chặn merge trong `security.yml` |
| P1-5 | Viết lại `docs/benchmarks.md` bằng số liệu P0-0; **rút toàn bộ tuyên bố trong `report_test.pdf`** |

### P2

| Mục | Nội dung |
|---|---|
| P2-1 *(N9)* | Keyset pagination |
| P2-2 *(N10, S3, S5)* | Rate limit theo tenant + hạn mức stream theo tenant |
| P2-3 | Partition bảng `executions` theo thời gian; chính sách lưu trữ |
| P2-4 | Read replica cho Workbench/history (`ARCHITECTURE.md §6 V0.3`) |

---

## Phần 5 — Điều kiện được phép tuyên bố hiệu năng

Áp dụng quy tắc sẵn có của dự án (`ARCHITECTURE.md §9`) cho tài liệu marketing:

Một con số chỉ được xuất hiện trong README, report hay trang bán hàng khi có đủ:

1. Script tái lập được, nằm trong repo.
2. Cấu hình phần cứng và phiên bản PostgreSQL ghi kèm.
3. **Ít nhất một đường cơ sở là thư viện thật**, không phải "tự code tay".
4. Cùng một trục đo cho cả hai phía (cùng chạm DB, hoặc cùng không).
5. p95 và p99, không chỉ giá trị trung bình hay ops/sec.

Report hiện tại không thoả điều kiện 3 và 4. Đề nghị: giữ lại **mục 4.1
(fault-test Stripe)** — phần đó là bằng chứng thật và là luận điểm mạnh nhất —
và bỏ toàn bộ Bảng 1, Bảng 2 cho tới khi P0-0 chạy xong.

---

## Xem thêm

- [Luồng và quan hệ giữa các tầng xử lý](./luong-va-quan-he-cac-tang.md) — bản đồ
  kiến trúc đầy đủ, gồm cả **bản đồ khoá** cho từng điểm nghẽn ở trên.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — ranh giới tầng và quy tắc phụ thuộc.
- [docs/runtime-flows.md](../runtime-flows.md) — sequence của engine Go.
