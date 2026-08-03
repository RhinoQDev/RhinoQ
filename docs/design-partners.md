# Get the first three design partners

Do not call a GitHub star or a friendly chat a design partner. A partner is a
team that connects one real workload, shares failure evidence and attends three
short feedback sessions during a 30-day pilot.

## The three seats

| Seat | Required workload | Proof RhinoQ must produce |
|---|---|---|
| A — Node/BullMQ | import, export, media or AI batch with at least 100 items | Task summary polling stays bounded; reconnect and partial Redis failure converge |
| B — Stripe/billing | refund, subscription or entitlement side effect | accepted-but-response-lost is reconciled without a duplicate call |
| C — provisioning/fulfilment | a job can finish while the business resource is missing or wrong | Rule creates a Finding; repair preview/approval/verification closes it safely |

The BullMQ repository has public Discussions and its official site positions it
as a Redis queue used by many companies, so start with maintainers of small
public BullMQ applications and discussion participants—not the core maintainers
themselves: <https://github.com/taskforcesh/bullmq/discussions>.

Stripe documents an official developer Discord. Join it to learn and ask for
opt-in interviews; do not cold-DM or paste promotional spam:
<https://docs.stripe.com/development>.

Temporal's official community promotes its Slack, and its ecosystem channel is
another place to interview teams about outcome verification even when RhinoQ
does not replace their workflow engine: <https://temporal.io/community>.

## Offer

- free 30-day integration and direct engineering support;
- RhinoQ adapts to their existing queue/database; no queue migration;
- no production credentials or customer payloads shared with RhinoQ;
- partner can stop at any time and keeps the integration patch;
- public logo/case study only with separate written permission.

## Outreach message

> I am testing RhinoQ, a small outcome-verification layer for background jobs.
> It does not replace BullMQ/Temporal. I am looking for one real case where a
> job can say “completed” while a payment, file or business row is still wrong.
> I will integrate the pilot with you for free, cap it at 30 days, and measure
> duplicate prevention, time-to-detect and integration code. Would a 20-minute
> technical call be useful? No sales deck and no production data required.

## Weekly funnel until all seats are signed

1. Build a list of 15 opt-in candidates: five per seat.
2. Send five personalised messages, each citing one concrete workload from a
   public repository, post or prior conversation.
3. Run discovery before demo: last incident, current reconciliation script,
   blast radius, and who owns the fix.
4. Accept only a workload with a reproducible mismatch and an engineer who can
   spend two hours in week one.
5. Record baseline and exit criteria before integration. A pilot is successful
   only if it catches or prevents a real failure with less operational work.

Track candidates privately with: source, contact permission, workload, current
workaround, incident frequency, pilot owner, next step and outcome. Never add a
person to the public repository without consent.

## Kill criteria

Stop and revisit the onboarding or positioning instead of adding features when
the pilot produces any of these signals:

| Signal | Threshold | Decision |
|---|---:|---|
| Partner writes the first Rule | more than 60 minutes | return to onboarding and remove the largest source of friction |
| A Rule catches a real mismatch | 0 partners in 14 days | test whether the problem is painful enough or the Rule contract is wrong |
| Partner writes a second Rule unaided | 0 of 3 partners by day 30 | the product is not self-serve yet |
| Findings per week | more than 50 with no operator action | reduce noise or revisit the alert policy |
| Partners retained at day 30 | fewer than 2 of 3 | stop expansion and interview for the reason |
