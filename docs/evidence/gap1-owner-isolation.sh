B="http://127.0.0.1:8099"
op(){ curl -s -w "\n<<%{http_code}>>" -H "Authorization: Bearer $RHINOQ_AGENT_TOKEN" -H "Content-Type: application/json" "$@"; }
a(){  curl -s -w "\n<<%{http_code}>>" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" "$@"; }
b(){  curl -s -w "\n<<%{http_code}>>" -H "Authorization: Bearer $OWNER_B_TOKEN" -H "Content-Type: application/json" "$@"; }
line(){ echo "--------------------------------------------------"; }

echo "SETUP (operator creates both tasks)"
op -X POST "$B/v1/tasks" -d '{"id":"gap1_task_a","type":"bulk-download","ownerId":"tenant-a","definitionVersion":1}' >/dev/null
op -X POST "$B/v1/tasks" -d '{"id":"gap1_task_b","type":"search-video","ownerId":"tenant-b","definitionVersion":1}' >/dev/null
op -X POST "$B/v1/tasks/gap1_task_a/state" -d '{"expectedVersion":1,"state":"queued"}' >/dev/null
op -X POST "$B/v1/tasks/gap1_task_b/state" -d '{"expectedVersion":1,"state":"queued"}' >/dev/null
op -X POST "$B/v1/tasks/gap1_task_a/result" -d '{"expectedVersion":2,"reference":"s3://bulk/gap1_task_a.zip"}' >/dev/null
line
echo "OWNER-A TOKEN"
echo "[4.1] GET own task A            -> expect 200 + ownerId tenant-a"; a "$B/v1/tasks/gap1_task_a"; echo
echo "[4.2] GET own result A          -> expect 200"; a "$B/v1/tasks/gap1_task_a/result"; echo
echo "[4.4] GET foreign task B        -> expect 404"; a "$B/v1/tasks/gap1_task_b"; echo
echo "[4.5] GET foreign result B      -> expect 404"; a "$B/v1/tasks/gap1_task_b/result"; echo
echo "[4.6] POST cancel foreign B     -> expect 404"; a -X POST "$B/v1/tasks/gap1_task_b/cancel" -d '{"expectedVersion":2}'; echo
echo "[4.7] GET /v1/jobs              -> expect 401"; a "$B/v1/jobs"; echo
echo "[4.8] POST generic state succeeded on OWN task -> expect 401"; a -X POST "$B/v1/tasks/gap1_task_a/state" -d '{"expectedVersion":3,"state":"succeeded"}'; echo
echo "[4.9a] Execution lookup         -> expect 401"; a "$B/v1/task-executions/lookup?runtime=bullmq&externalId=x"; echo
echo "[4.9b] Execution create         -> expect 401"; a -X POST "$B/v1/tasks/gap1_task_a/executions" -d '{"id":"e1","runtime":"bullmq"}'; echo
echo "[4.9c] Execution bind           -> expect 401"; a -X POST "$B/v1/task-executions/e1/bind" -d '{"runtime":"bullmq","externalId":"x"}'; echo
echo "[4.3] POST cancel OWN task A    -> expect 200"; a -X POST "$B/v1/tasks/gap1_task_a/cancel" -d '{"expectedVersion":3}'; echo
line
echo "OWNER-B TOKEN (symmetric)"
echo "[B.1] GET own task B            -> expect 200 + ownerId tenant-b"; b "$B/v1/tasks/gap1_task_b"; echo
echo "[B.4] GET foreign task A        -> expect 404"; b "$B/v1/tasks/gap1_task_a"; echo
echo "[B.5] GET foreign result A      -> expect 404"; b "$B/v1/tasks/gap1_task_a/result"; echo
echo "[B.6] POST cancel foreign A     -> expect 404"; b -X POST "$B/v1/tasks/gap1_task_a/cancel" -d '{"expectedVersion":4}'; echo
line
echo "NONEXISTENT TASK via owner-A (existence-leak check) -> must match [4.4] byte-for-byte"
a "$B/v1/tasks/gap1_task_does_not_exist"; echo
