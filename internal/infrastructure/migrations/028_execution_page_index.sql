-- RhinoQ migration 028: make the Execution page cost what a page should.
--
-- ListTaskExecutionsPage is a keyset page ordered by (created_at, id), and
-- migration 015 gave the table an index on (task_id, attempt). Those do not
-- match, so PostgreSQL had no ordered path to walk: it read every Execution
-- belonging to the Task and top-N sorted them to find fifty.
--
-- The correctness argument for keyset pagination was never affected — rows
-- still cannot shift between pages — so nothing failed and nothing was slow
-- enough to notice at the fan-out the tests used. It surfaced only when
-- tests/postgres/adopter_workload_bench_test.go asked for the same page at
-- three fan-out sizes:
--
--     fanout=100    2.04 ms/op
--     fanout=1000   2.86 ms/op
--     fanout=5000   6.84 ms/op
--
-- A page of fifty rows costing 3.4x more because the Task has more rows
-- elsewhere is the definition of unbounded, and a batch job is exactly where
-- fan-out grows.
--
-- This index alone does not fix it, which is worth recording because the
-- obvious conclusion was wrong. With stale statistics the planner estimated
-- twelve matching rows, chose a bitmap scan — which returns no order — and
-- sorted all five thousand anyway, using this very index to do it. The plan
-- only flips to an ordered index scan once the table has been analysed:
--
--     before          bitmap scan + top-N sort, 5000 rows read, 4.218 ms
--     after ANALYZE   index scan, 51 rows read, 14 buffers, 0.137 ms
--
-- End to end through the client, the page at fan-out 5000 went from 6.84 ms
-- to 1.92 ms and stopped growing with fan-out. Autovacuum keeps statistics
-- current in a running deployment, so the pathological plan is mainly a
-- hazard immediately after a bulk import — which is exactly when a batch job
-- creates five thousand Executions and somebody opens the page to watch them.
-- docs/operations.md carries the ANALYZE note for that case.
--
-- The index leads with task_id rather than tenant_id even though every query
-- is tenant-scoped: the row-level policy is an OR (tenant match or maintenance
-- session), which the planner cannot turn into an index condition. Leading
-- with tenant_id would therefore buy nothing and cost a column. The tenant
-- predicate stays a filter over the handful of rows the page actually reads.
SET search_path = public;

CREATE INDEX IF NOT EXISTS rhinoq_task_executions_page_idx
    ON rhinoq_task_executions (task_id, created_at, id);

COMMENT ON INDEX rhinoq_task_executions_page_idx IS
    'Serves the keyset order of ListTaskExecutionsPage so a page costs its own size, not the task''s fan-out.';
