CREATE TABLE IF NOT EXISTS public.rhinoq_example_reports (
    id          text PRIMARY KEY,
    status      text NOT NULL,
    output_key  text,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.rhinoq_example_reports (id, status, output_key, updated_at)
VALUES
    ('report_ready', 'completed', 'reports/report_ready.pdf', now()),
    ('report_missing', 'completed', NULL, now()),
    ('report_processing', 'processing', NULL, now())
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    output_key = EXCLUDED.output_key,
    updated_at = EXCLUDED.updated_at;
