B="http://127.0.0.1:8099"
OP="Authorization: Bearer $RHINOQ_AGENT_TOKEN"
A="Authorization: Bearer $OWNER_A_TOKEN"
J="Content-Type: application/json"
v(){ curl -s -H "$OP" "$B/v1/tasks/$1" | node -pe "JSON.parse(require('fs').readFileSync(0)).entityVersion"; }
show(){ curl -s -H "$OP" "$B/v1/tasks/$1" | node -pe "const s=JSON.parse(require('fs').readFileSync(0));'state='+s.state+'  cancellation='+JSON.stringify(s.cancellation)"; }
mk(){ curl -s -H "$OP" -H "$J" -X POST "$B/v1/tasks" -d "{\"id\":\"$1\",\"type\":\"t\",\"ownerId\":\"tenant-a\",\"definitionVersion\":1}" >/dev/null
      curl -s -H "$OP" -H "$J" -X POST "$B/v1/tasks/$1/state" -d "{\"expectedVersion\":$(v $1),\"state\":\"queued\"}" >/dev/null
      curl -s -H "$OP" -H "$J" -X POST "$B/v1/tasks/$1/state" -d "{\"expectedVersion\":$(v $1),\"state\":\"running\"}" >/dev/null; }

echo "=== Scenario A: cancel succeeds ==="
mk c_a
curl -s -o /dev/null -H "$A" -H "$J" -X POST "$B/v1/tasks/c_a/cancel" -d "{\"expectedVersion\":$(v c_a)}"
echo "after owner request : $(show c_a)"
curl -s -o /dev/null -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_a/cancellation" -d "{\"expectedVersion\":$(v c_a),\"status\":\"acknowledged\"}"
echo "after ack           : $(show c_a)"
curl -s -o /dev/null -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_a/state" -d "{\"expectedVersion\":$(v c_a),\"state\":\"cancelled\"}"
echo "FINAL               : $(show c_a)   [expect state=cancelled cancellation.status=cancelled]"
echo
echo "=== Scenario B: cancel too late ==="
mk c_b
curl -s -o /dev/null -H "$A" -H "$J" -X POST "$B/v1/tasks/c_b/cancel" -d "{\"expectedVersion\":$(v c_b)}"
curl -s -o /dev/null -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_b/cancellation" -d "{\"expectedVersion\":$(v c_b),\"status\":\"acknowledged\"}"
echo "after ack           : $(show c_b)"
curl -s -o /dev/null -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_b/state" -d "{\"expectedVersion\":$(v c_b),\"state\":\"succeeded\"}"
echo "FINAL               : $(show c_b)   [expect state=succeeded cancellation.status=too_late]"
echo
echo "  control task, never cancelled:"
mk c_ctl
curl -s -o /dev/null -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_ctl/state" -d "{\"expectedVersion\":$(v c_ctl),\"state\":\"succeeded\"}"
echo "  CONTROL            : $(show c_ctl)   [must differ from Scenario B]"
echo
echo "=== Scenario C: cannot cancel safely ==="
mk c_c
curl -s -o /dev/null -H "$A" -H "$J" -X POST "$B/v1/tasks/c_c/cancel" -d "{\"expectedVersion\":$(v c_c)}"
curl -s -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_c/cancellation" -d "{\"expectedVersion\":$(v c_c),\"status\":\"cannot_cancel_safely\",\"reason\":\"S3 multipart upload already committed; cancelling now would leave a partial archive. Wait for it to finish, then delete the batch.\"}" | node -pe "const s=JSON.parse(require('fs').readFileSync(0));'FINAL               : state='+s.state+'  cancellation='+JSON.stringify(s.cancellation)"
echo "  [expect state=cancel_requested cancellation.status=cannot_cancel_safely + actionable reason]"
echo
echo "=== Scenario D: retry after cancelled ==="
echo "before requeue      : $(show c_a)"
curl -s -o /dev/null -H "$OP" -H "$J" -X POST "$B/v1/tasks/c_a/state" -d "{\"expectedVersion\":$(v c_a),\"state\":\"queued\"}"
echo "FINAL after requeue : $(show c_a)   [expect state=queued cancellation.status=none]"
echo
echo "=== Idempotency: duplicate cancel request ==="
mk c_idem
curl -s -o /dev/null -H "$A" -H "$J" -X POST "$B/v1/tasks/c_idem/cancel" -d "{\"expectedVersion\":$(v c_idem)}"
V1=$(v c_idem); echo "first  cancel -> v=$V1 $(show c_idem)"
curl -s -w "  second cancel HTTP %{http_code}\n" -o /dev/null -H "$A" -H "$J" -X POST "$B/v1/tasks/c_idem/cancel" -d "{\"expectedVersion\":$V1}"
echo "after duplicate     : v=$(v c_idem) $(show c_idem)"
