B="http://127.0.0.1:8099"
op(){ curl -s -w " <<%{http_code}>>" -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" -H "Content-Type: application/json" "$@"; }
ver(){ curl -s -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" "$B/v1/tasks/gap2_task" | node -pe "JSON.parse(require('fs').readFileSync(0)).entityVersion"; }
prog(){ curl -s -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" "$B/v1/tasks/gap2_task" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync(0)).progress)"; }

op -X POST "$B/v1/tasks" -d '{"id":"gap2_task","type":"bulk-download","ownerId":"tenant-a","definitionVersion":1}' >/dev/null
op -X POST "$B/v1/tasks/gap2_task/state" -d '{"expectedVersion":1,"state":"queued"}' >/dev/null
op -X POST "$B/v1/tasks/gap2_task/state" -d '{"expectedVersion":2,"state":"running"}' >/dev/null

echo "[5.1] progress 5/10 @v$(ver) -> expect 200"
op -X POST "$B/v1/tasks/gap2_task/progress" -d "{\"expectedVersion\":$(ver),\"progress\":{\"completed\":5,\"total\":10}}"; echo; echo
echo "[5.2] snapshot progress now: $(prog)"; echo
echo "[5.3] REGRESSION 2/10 @v$(ver) -> expect 409 RHINOQ_PROGRESS_REGRESSION"
op -X POST "$B/v1/tasks/gap2_task/progress" -d "{\"expectedVersion\":$(ver),\"progress\":{\"completed\":2,\"total\":10}}"; echo
echo "      snapshot after regression attempt: $(prog)  (must still be 5/10)"; echo
echo "[5.4] TOTAL CHANGED 6/12 @v$(ver) -> expect 409 RHINOQ_PROGRESS_TOTAL_CHANGED"
op -X POST "$B/v1/tasks/gap2_task/progress" -d "{\"expectedVersion\":$(ver),\"progress\":{\"completed\":6,\"total\":12}}"; echo
echo "      snapshot: $(prog)"; echo
echo "[5.5] forward 6/10 @v$(ver) -> expect 200"
op -X POST "$B/v1/tasks/gap2_task/progress" -d "{\"expectedVersion\":$(ver),\"progress\":{\"completed\":6,\"total\":10}}"; echo; echo
echo "[5.6] stale expectedVersion=2 -> expect RHINOQ_VERSION_CONFLICT"
op -X POST "$B/v1/tasks/gap2_task/progress" -d '{"expectedVersion":2,"progress":{"completed":9,"total":10}}'; echo
echo "      final snapshot: $(prog)"
echo
echo "[5.7] IDEMPOTENT duplicate: re-send 6/10 @v$(ver) -> observe"
op -X POST "$B/v1/tasks/gap2_task/progress" -d "{\"expectedVersion\":$(ver),\"progress\":{\"completed\":6,\"total\":10}}"; echo
echo "      final: $(prog) @v$(ver)"
