-- Bind an idempotency key to the request shape that created it.
SET search_path = public;

ALTER TABLE rhinoq_provider_operations
    ADD COLUMN IF NOT EXISTS request_fingerprint text NOT NULL DEFAULT '';

ALTER TABLE rhinoq_provider_operations
    ADD CONSTRAINT rhinoq_provider_operations_request_fingerprint_check
    CHECK (octet_length(request_fingerprint) <= 128);
