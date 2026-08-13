ALTER TABLE rhinoq_task_schedules
    ALTER COLUMN every_ms DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS cron_expression text,
    ADD COLUMN IF NOT EXISTS timezone text;

ALTER TABLE rhinoq_task_schedules
    DROP CONSTRAINT IF EXISTS rhinoq_task_schedules_schedule_kind_check;
ALTER TABLE rhinoq_task_schedules
    ADD CONSTRAINT rhinoq_task_schedules_schedule_kind_check CHECK (
        (every_ms IS NOT NULL AND cron_expression IS NULL AND timezone IS NULL) OR
        (every_ms IS NULL AND length(btrim(cron_expression)) > 0 AND length(btrim(timezone)) > 0)
    );
