SELECT id::text AS subject_id,
       output_url IS NULL AS violated,
       jsonb_build_object('status', status, 'hasOutput', output_url IS NOT NULL) AS evidence
FROM completed_reports
WHERE created_at >= $1
  AND id::text > $2
ORDER BY id
LIMIT $3
