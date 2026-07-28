-- RhinoQ migration 010: persist what a Rule does with an inconclusive check.
--
-- Observations were boolean, so a check that could not reach its provider, read
-- an object or wait out a confirmation deadline had to answer pass or violate.
-- false read as "this subject is fine", which silently closed real drift the
-- moment a dependency became unreachable.
--
-- Observations are now three-valued: the query returns NULL for violated when
-- it cannot decide, and this column records what RhinoQ should do about it.
-- 'retry' opens nothing and asks again next evaluation; 'finding' treats not
-- knowing as drift a person must look at.
--
-- The default is 'retry' because most unknowns are transient, and an alert per
-- transient failure teaches operators to ignore alerts. Existing rules keep
-- their current behaviour under it: they never return NULL, so the column never
-- applies to them.
SET search_path = public;

ALTER TABLE rhinoq_rules
    ADD COLUMN IF NOT EXISTS on_unknown text NOT NULL DEFAULT 'retry';

ALTER TABLE rhinoq_rules
    DROP CONSTRAINT IF EXISTS rhinoq_rules_on_unknown_check;
ALTER TABLE rhinoq_rules
    ADD CONSTRAINT rhinoq_rules_on_unknown_check
    CHECK (on_unknown IN ('retry', 'finding'));

COMMENT ON COLUMN rhinoq_rules.on_unknown IS
    'What an inconclusive observation does: retry asks again, finding opens drift for a person. Applies only when the rule query returns NULL for violated.';
