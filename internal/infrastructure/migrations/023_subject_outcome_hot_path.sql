-- Two costs measured against a production-shaped schema, both on the path every
-- observed subject walks.
--
-- 1. Evidence was stored for passing subjects. On 40 000 subjects of one Rule
--    that was 5.4 MB of the table's 16 MB, and it answered a question nobody
--    asks: evidence explains why something is wrong. The Rule's own query can
--    always produce it again for a subject that currently passes.
--
-- 2. The foreign key to rhinoq_rules made PostgreSQL look the Rule up once per
--    inserted row — 40 099 index probes for a value that is constant for the
--    whole page. The Rule's identity is already validated in the application
--    before a page is written, and DeleteRule now removes outcomes explicitly
--    instead of relying on ON DELETE CASCADE.
SET search_path = public;

UPDATE rhinoq_subject_outcomes
SET evidence = NULL
WHERE status = 'passed' AND evidence IS NOT NULL;

ALTER TABLE rhinoq_subject_outcomes
    DROP CONSTRAINT IF EXISTS rhinoq_subject_outcomes_rule_id_rule_version_fkey;

-- The invariant the foreign key used to imply is now stated directly: a passing
-- subject carries status and timing, never evidence.
ALTER TABLE rhinoq_subject_outcomes
    DROP CONSTRAINT IF EXISTS rhinoq_subject_outcomes_passed_evidence_check;
ALTER TABLE rhinoq_subject_outcomes
    ADD CONSTRAINT rhinoq_subject_outcomes_passed_evidence_check
    CHECK (status <> 'passed' OR evidence IS NULL);

-- Retention deletes by age, and without this the prune below would sequentially
-- scan the largest table RhinoQ owns.
CREATE INDEX IF NOT EXISTS rhinoq_subject_outcomes_observed_idx
    ON rhinoq_subject_outcomes (last_observed_at)
    WHERE status = 'passed';
