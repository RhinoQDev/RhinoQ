-- ProviderOperation v1 public contract: Task linkage, explicit policies and
-- append-only evidence separate from the operation's business mapping.
SET search_path = public;

ALTER TABLE rhinoq_provider_operations
    ADD COLUMN IF NOT EXISTS task_id text,
    ADD COLUMN IF NOT EXISTS confirmation_policy text NOT NULL DEFAULT 'readback',
    ADD COLUMN IF NOT EXISTS retry_policy text NOT NULL DEFAULT 'when-not-happened';

ALTER TABLE rhinoq_provider_operations
    DROP CONSTRAINT IF EXISTS rhinoq_provider_operations_state_check;
ALTER TABLE rhinoq_provider_operations
    ADD CONSTRAINT rhinoq_provider_operations_state_check CHECK (state IN (
        'pending','accepted','confirmed','failed','not_happened','rejected','uncertain'
    )),
    ADD CONSTRAINT rhinoq_provider_operations_confirmation_check CHECK (
        confirmation_policy IN ('on-return','readback','webhook')
    ),
    ADD CONSTRAINT rhinoq_provider_operations_retry_check CHECK (
        retry_policy IN ('never','when-not-happened')
    );

CREATE INDEX IF NOT EXISTS rhinoq_provider_operations_task_idx
    ON rhinoq_provider_operations (task_id, updated_at DESC, id)
    WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rhinoq_provider_operation_evidence (
    sequence      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id  text NOT NULL REFERENCES rhinoq_provider_operations(id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (btrim(kind) <> '' AND octet_length(kind) <= 64),
    payload        text NOT NULL CHECK (btrim(payload) <> '' AND octet_length(payload) <= 65536),
    created_at     timestamptz NOT NULL
);

INSERT INTO rhinoq_provider_operation_evidence (operation_id, kind, payload, created_at)
SELECT id, 'legacy', evidence, updated_at
FROM rhinoq_provider_operations
WHERE evidence IS NOT NULL AND btrim(evidence) <> '';

UPDATE rhinoq_provider_operations SET evidence=NULL WHERE evidence IS NOT NULL;

CREATE INDEX IF NOT EXISTS rhinoq_provider_operation_evidence_operation_idx
    ON rhinoq_provider_operation_evidence (operation_id, sequence);
