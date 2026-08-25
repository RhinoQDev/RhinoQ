# External usability pilot

Use this protocol with 3–5 Node.js developers who have not used RhinoQ. Give
them only the repository and npm links plus the tasks below. Do not explain the
architecture, commands or expected solution while the timer is running.

## Participant brief

Use RhinoQ `0.1.0-beta.23` in an existing Node.js application with PostgreSQL
and BullMQ. Treat it as a public beta for evaluation, not production software.

1. Integrate RhinoQ and make one existing BullMQ job visible in Task Center.
2. Create a batch/fan-out Task, run it, and find its progress and result.
3. Make one Task fail or become stuck, then use RhinoQ to explain the problem
   and choose a recovery action. Do not query PostgreSQL manually.

Stop and record the blocker if documentation or tooling does not provide a safe
next step. Do not ask the maintainer for setup instructions during the test.

## Observer record

Record timestamps and evidence, not impressions reconstructed afterwards:

- start → completed `npm install`;
- start → first visible Task;
- start → working existing-BullMQ integration;
- start → first completed handler;
- start → first Finding or clearly explained incident;
- whether all three tasks completed without maintainer intervention;
- every setup error and whether `rhinoq doctor` explained it;
- every return to documentation, including the page and reason;
- every unfamiliar concept or question;
- whether the incident was resolved without ad-hoc SQL;
- routes, files, processes and credentials added or removed;
- before/after application LOC for context, not as the sole success measure.

After each task ask exactly: **How easy was this? (1–7)**. Do not rephrase the
question or explain the scale beyond 1 = very difficult and 7 = very easy.

## Beta usability gate

These are targets, not current claims:

- first visible Task within 15 minutes of starting from npm;
- existing BullMQ integration working within 30 minutes;
- at least 4 of 5 participants complete all tasks without intervention;
- median ease score at least 5/7;
- setup failures have an actionable explanation;
- incident diagnosis and recovery do not require manual SQL.

Failing a target creates an onboarding or product issue with the participant's
evidence attached. It does not become a request for another feature unless the
same blocker survives a documentation or diagnostic improvement.
