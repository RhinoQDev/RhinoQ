-- RhinoQ migration 014: record how a table Rule walks its subjects.
--
-- A table Rule paged on subject_id alone. That is bounded and complete, and it
-- is blind to recency: a row updated a second ago waits for the walk to reach
-- its id, which on a large table can be a full pass away. Signal-first
-- verification covers the changes an application remembers to announce; this
-- covers the ones it does not, without re-reading every row on every pass.
--
-- 'changed' pages on (changed_at, subject_id). The composite is not a detail.
-- Ordering by a timestamp alone is unstable when rows share one, and paging an
-- unstable order skips records - which for an integrity checker means reporting
-- a table clean because it never looked at part of it.
--
-- Existing rules default to 'subject' and are unaffected: their queries take no
-- $5 and return no changed_at, so nothing about their behaviour changes.
SET search_path = public;

ALTER TABLE rhinoq_rules
    ADD COLUMN IF NOT EXISTS cursor_mode text NOT NULL DEFAULT 'subject';

ALTER TABLE rhinoq_rules
    DROP CONSTRAINT IF EXISTS rhinoq_rules_cursor_mode_check;
ALTER TABLE rhinoq_rules
    ADD CONSTRAINT rhinoq_rules_cursor_mode_check
    CHECK (cursor_mode IN ('subject', 'changed'));

COMMENT ON COLUMN rhinoq_rules.cursor_mode IS
    'subject pages by subject_id: bounded, complete, blind to recency. changed pages by (changed_at, subject_id) so a row that just moved is seen on the next page; its query must accept $5 and return changed_at.';
