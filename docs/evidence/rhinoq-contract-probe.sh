T="rhinoq_eval_token_0123456789abcdef0123456789abcdef"
B="http://127.0.0.1:8099"
H="-H Authorization:Bearer${T}"
q(){ curl -s -H "Authorization: Bearer $T" -H "Content-Type: application/json" "$@"; }

echo "### 1. ownerId / tenant isolation"
q -X POST "$B/v1/tasks" -d '{"id":"probe_owner_1","type":"probe","ownerId":"tenant-A","definitionVersion":1}'; echo
echo "-- GET with no owner context (any bearer holder):"
q "$B/v1/tasks/probe_owner_1"; echo
echo
echo "### 2. progress monotonicity"
q -X POST "$B/v1/tasks/probe_owner_1/state" -d '{"expectedVersion":1,"state":"queued"}' >/dev/null
q -X POST "$B/v1/tasks/probe_owner_1/state" -d '{"expectedVersion":2,"state":"running"}' >/dev/null
echo "-- forward progress 5/10:"
q -X POST "$B/v1/tasks/probe_owner_1/progress" -d '{"expectedVersion":3,"progress":{"completed":5,"total":10}}'; echo
echo "-- BACKWARD progress 2/10 with correct version:"
q -X POST "$B/v1/tasks/probe_owner_1/progress" -d '{"expectedVersion":4,"progress":{"completed":2,"total":10}}'; echo
echo
echo "### 3. cancel arriving too late"
q -X POST "$B/v1/tasks/probe_owner_1/state" -d '{"expectedVersion":5,"state":"cancel_requested"}'; echo
echo "-- worker finished anyway -> succeeded:"
q -X POST "$B/v1/tasks/probe_owner_1/state" -d '{"expectedVersion":6,"state":"succeeded"}'; echo
echo "-- final snapshot as a UI would read it:"
q "$B/v1/tasks/probe_owner_1"; echo
