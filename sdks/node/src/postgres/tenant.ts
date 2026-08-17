/**
 * Characters a tenant identifier may contain.
 *
 * A tenant reaches PostgreSQL two ways: as `-c rhinoq.tenant_id=<value>` in a
 * connection's startup options, and as a bound parameter to `set_config`. The
 * second is safe by construction. The first is a space-separated command line,
 * so a value containing whitespace does not fail — it starts a second option.
 * `acme -c search_path=public` would set a tenant *and* quietly change the
 * schema resolution of every query on that connection.
 *
 * Today those values pass through `URL.searchParams`, which percent-encodes
 * them, so the attack does not land. That is a property of one code path rather
 * than a rule, and it is not written down anywhere: a caller that builds the
 * option string directly — `withPostgresOption` does exactly that when it has
 * no URL to merge into — has no such protection.
 *
 * The character set is deliberately narrow. It covers UUIDs, slugs, numeric ids
 * and namespaced forms like `eu:acme`, and excludes everything that means
 * something to a shell-style option list.
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Returns the tenant id, or refuses it.
 *
 * Refusing costs one failed request. Accepting a tenant id that can carry a
 * second startup option costs a connection whose session settings are not the
 * ones the deployment configured, for as long as that connection stays pooled.
 */
export function assertTenantId(value: unknown): string {
  const tenantId = typeof value === 'string' ? value.trim() : '';
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError(
      'RHINOQ_INVALID_TENANT_ID: a tenant id must be 1-64 characters of '
      + 'A-Z a-z 0-9 . _ : or -, and must not contain whitespace. '
      + `Received ${JSON.stringify(value)}.`,
    );
  }
  return tenantId;
}

/** Non-throwing form, for callers that want to branch rather than catch. */
export function isValidTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value.trim());
}
