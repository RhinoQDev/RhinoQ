/**
 * Shared worker capacity for the Task profile. A pool row is the serialization
 * point: admissions lock it, reap expired leases using database time, and only
 * then sum active allocations. This prevents cross-process oversubscription
 * without moving scheduler correctness into Node.
 */
export const TASK_SCHEMA_V20_NAME = '020_shared_resource_leases';

export const TASK_SCHEMA_V20_SQL = String.raw`
CREATE TABLE IF NOT EXISTS rhinoq_task.resource_pools (
  tenant_id text NOT NULL DEFAULT rhinoq_task.current_tenant() CHECK (btrim(tenant_id) <> ''),
  pool_key text NOT NULL CHECK (btrim(pool_key) <> '' AND length(pool_key) <= 128),
  cpu_capacity integer NOT NULL CHECK (cpu_capacity >= 0),
  memory_capacity_bytes bigint NOT NULL CHECK (memory_capacity_bytes >= 0),
  disk_capacity_bytes bigint NOT NULL CHECK (disk_capacity_bytes >= 0),
  network_capacity integer NOT NULL CHECK (network_capacity >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, pool_key),
  CHECK (cpu_capacity > 0 OR memory_capacity_bytes > 0 OR disk_capacity_bytes > 0 OR network_capacity > 0)
);

CREATE TABLE IF NOT EXISTS rhinoq_task.resource_leases (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
  pool_key text NOT NULL CHECK (btrim(pool_key) <> '' AND length(pool_key) <= 128),
  task_id text NOT NULL,
  execution_id text NOT NULL,
  lease_owner text NOT NULL CHECK (btrim(lease_owner) <> ''),
  lease_epoch bigint NOT NULL DEFAULT 1 CHECK (lease_epoch > 0),
  cpu integer NOT NULL CHECK (cpu >= 0),
  memory_bytes bigint NOT NULL CHECK (memory_bytes >= 0),
  disk_bytes bigint NOT NULL CHECK (disk_bytes >= 0),
  network integer NOT NULL CHECK (network >= 0),
  state text NOT NULL CHECK (state IN ('active','released','expired')),
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  UNIQUE (tenant_id, task_id, execution_id, pool_key),
  FOREIGN KEY (tenant_id, pool_key) REFERENCES rhinoq_task.resource_pools(tenant_id, pool_key) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, tenant_id) REFERENCES rhinoq_task.tasks(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id, tenant_id) REFERENCES rhinoq_task.executions(id, tenant_id) ON DELETE CASCADE,
  CHECK (cpu > 0 OR memory_bytes > 0 OR disk_bytes > 0 OR network > 0)
);

CREATE INDEX IF NOT EXISTS resource_leases_pool_active_idx
  ON rhinoq_task.resource_leases(tenant_id, pool_key, lease_until, id)
  WHERE state = 'active';

CREATE OR REPLACE FUNCTION rhinoq_task.acquire_resource_lease(
  p_id text,
  p_pool_key text,
  p_task_id text,
  p_execution_id text,
  p_lease_owner text,
  p_cpu_capacity integer,
  p_memory_capacity_bytes bigint,
  p_disk_capacity_bytes bigint,
  p_network_capacity integer,
  p_cpu integer,
  p_memory_bytes bigint,
  p_disk_bytes bigint,
  p_network integer,
  p_lease_ms integer
)
RETURNS TABLE(
  id text, pool_key text, task_id text, execution_id text, lease_owner text,
  lease_epoch bigint, cpu integer, memory_bytes bigint, disk_bytes bigint,
  network integer, lease_until timestamptz
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_task rhinoq_task.tasks%ROWTYPE;
  v_execution rhinoq_task.executions%ROWTYPE;
  v_pool rhinoq_task.resource_pools%ROWTYPE;
  v_lease rhinoq_task.resource_leases%ROWTYPE;
  v_cpu_used bigint := 0;
  v_memory_used bigint := 0;
  v_disk_used bigint := 0;
  v_network_used bigint := 0;
  v_now timestamptz := clock_timestamp();
  v_key text := btrim(COALESCE(p_pool_key, ''));
  v_existing boolean := false;
BEGIN
  IF btrim(COALESCE(p_id, '')) = '' OR v_key = '' OR btrim(COALESCE(p_task_id, '')) = ''
     OR btrim(COALESCE(p_execution_id, '')) = '' OR btrim(COALESCE(p_lease_owner, '')) = ''
     OR length(v_key) > 128 OR p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 3600000
     OR p_cpu_capacity IS NULL OR p_memory_capacity_bytes IS NULL OR p_disk_capacity_bytes IS NULL OR p_network_capacity IS NULL
     OR p_cpu IS NULL OR p_memory_bytes IS NULL OR p_disk_bytes IS NULL OR p_network IS NULL
     OR p_cpu_capacity < 0 OR p_memory_capacity_bytes < 0 OR p_disk_capacity_bytes < 0 OR p_network_capacity < 0
     OR p_cpu < 0 OR p_memory_bytes < 0 OR p_disk_bytes < 0 OR p_network < 0
     OR (p_cpu_capacity = 0 AND p_memory_capacity_bytes = 0 AND p_disk_capacity_bytes = 0 AND p_network_capacity = 0)
     OR (p_cpu = 0 AND p_memory_bytes = 0 AND p_disk_bytes = 0 AND p_network = 0) THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_RESOURCE_LEASE');
  END IF;

  SELECT * INTO v_task FROM rhinoq_task.tasks WHERE tasks.id = p_task_id;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_TASK_NOT_FOUND', p_task_id); END IF;
  SELECT * INTO v_execution FROM rhinoq_task.executions
  WHERE executions.id = p_execution_id AND executions.task_id = p_task_id AND executions.tenant_id = v_task.tenant_id;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_LEASE_EXECUTION_MISMATCH'); END IF;

  INSERT INTO rhinoq_task.resource_pools(
    tenant_id, pool_key, cpu_capacity, memory_capacity_bytes, disk_capacity_bytes, network_capacity
  ) VALUES (
    v_task.tenant_id, v_key, p_cpu_capacity, p_memory_capacity_bytes, p_disk_capacity_bytes, p_network_capacity
  ) ON CONFLICT (tenant_id, pool_key) DO NOTHING;

  SELECT * INTO v_pool FROM rhinoq_task.resource_pools
  WHERE tenant_id = v_task.tenant_id AND pool_key = v_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_POOL_NOT_FOUND', v_key); END IF;
  IF v_pool.cpu_capacity <> p_cpu_capacity
     OR v_pool.memory_capacity_bytes <> p_memory_capacity_bytes
     OR v_pool.disk_capacity_bytes <> p_disk_capacity_bytes
     OR v_pool.network_capacity <> p_network_capacity THEN
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_POOL_CONFIG_MISMATCH', v_key);
  END IF;
  IF p_cpu > v_pool.cpu_capacity OR p_memory_bytes > v_pool.memory_capacity_bytes
     OR p_disk_bytes > v_pool.disk_capacity_bytes OR p_network > v_pool.network_capacity THEN
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_REQUEST_EXCEEDS_CAPACITY', v_key);
  END IF;

  UPDATE rhinoq_task.resource_leases
  SET state = 'expired', updated_at = v_now, released_at = v_now
  WHERE tenant_id = v_task.tenant_id AND pool_key = v_key
    AND state = 'active' AND lease_until <= v_now;

  SELECT * INTO v_lease FROM rhinoq_task.resource_leases
  WHERE tenant_id = v_task.tenant_id AND task_id = p_task_id
    AND execution_id = p_execution_id AND pool_key = v_key FOR UPDATE;
  v_existing := FOUND;
  IF v_existing AND v_lease.state = 'active' AND v_lease.lease_until > v_now THEN
    IF v_lease.lease_owner = btrim(p_lease_owner)
       AND v_lease.cpu = p_cpu AND v_lease.memory_bytes = p_memory_bytes
       AND v_lease.disk_bytes = p_disk_bytes AND v_lease.network = p_network THEN
      RETURN QUERY SELECT v_lease.id, v_lease.pool_key, v_lease.task_id, v_lease.execution_id,
        v_lease.lease_owner, v_lease.lease_epoch, v_lease.cpu, v_lease.memory_bytes,
        v_lease.disk_bytes, v_lease.network, v_lease.lease_until;
      RETURN;
    END IF;
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_LEASE_HELD', v_key);
  END IF;

  SELECT COALESCE(sum(cpu), 0), COALESCE(sum(memory_bytes), 0),
         COALESCE(sum(disk_bytes), 0), COALESCE(sum(network), 0)
  INTO v_cpu_used, v_memory_used, v_disk_used, v_network_used
  FROM rhinoq_task.resource_leases
  WHERE tenant_id = v_task.tenant_id AND pool_key = v_key
    AND state = 'active' AND lease_until > v_now;
  IF v_cpu_used + p_cpu > v_pool.cpu_capacity
     OR v_memory_used + p_memory_bytes > v_pool.memory_capacity_bytes
     OR v_disk_used + p_disk_bytes > v_pool.disk_capacity_bytes
     OR v_network_used + p_network > v_pool.network_capacity THEN
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_UNAVAILABLE', v_key);
  END IF;

  IF v_existing THEN
    UPDATE rhinoq_task.resource_leases
    SET id = p_id, lease_owner = btrim(p_lease_owner), lease_epoch = v_lease.lease_epoch + 1,
        cpu = p_cpu, memory_bytes = p_memory_bytes, disk_bytes = p_disk_bytes, network = p_network,
        state = 'active', lease_until = v_now + make_interval(secs => p_lease_ms::double precision / 1000.0),
        updated_at = v_now, released_at = NULL
    WHERE tenant_id = v_task.tenant_id AND task_id = p_task_id
      AND execution_id = p_execution_id AND pool_key = v_key
    RETURNING * INTO v_lease;
  ELSE
    INSERT INTO rhinoq_task.resource_leases(
      id, tenant_id, pool_key, task_id, execution_id, lease_owner, lease_epoch,
      cpu, memory_bytes, disk_bytes, network, state, lease_until
    ) VALUES (
      p_id, v_task.tenant_id, v_key, p_task_id, p_execution_id, btrim(p_lease_owner), 1,
      p_cpu, p_memory_bytes, p_disk_bytes, p_network, 'active',
      v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
    ) RETURNING * INTO v_lease;
  END IF;
  RETURN QUERY SELECT v_lease.id, v_lease.pool_key, v_lease.task_id, v_lease.execution_id,
    v_lease.lease_owner, v_lease.lease_epoch, v_lease.cpu, v_lease.memory_bytes,
    v_lease.disk_bytes, v_lease.network, v_lease.lease_until;
END;
$fn$;

CREATE OR REPLACE FUNCTION rhinoq_task.renew_resource_lease(
  p_id text, p_lease_owner text, p_lease_epoch bigint, p_lease_ms integer
)
RETURNS TABLE(id text, pool_key text, task_id text, execution_id text, lease_owner text,
  lease_epoch bigint, cpu integer, memory_bytes bigint, disk_bytes bigint, network integer, lease_until timestamptz)
LANGUAGE plpgsql
AS $fn$
DECLARE v_lease rhinoq_task.resource_leases%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  IF btrim(COALESCE(p_id, '')) = '' OR btrim(COALESCE(p_lease_owner, '')) = ''
     OR p_lease_epoch IS NULL OR p_lease_epoch < 1 OR p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 3600000 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_RESOURCE_LEASE_RENEWAL');
  END IF;
  SELECT * INTO v_lease FROM rhinoq_task.resource_leases WHERE resource_leases.id = p_id FOR UPDATE;
  IF NOT FOUND OR v_lease.state <> 'active' OR v_lease.lease_owner <> btrim(p_lease_owner)
     OR v_lease.lease_epoch <> p_lease_epoch OR v_lease.lease_until <= v_now THEN
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_LEASE_FENCED', p_id);
  END IF;
  UPDATE rhinoq_task.resource_leases
  SET lease_until = v_now + make_interval(secs => p_lease_ms::double precision / 1000.0), updated_at = v_now
  WHERE id = v_lease.id RETURNING * INTO v_lease;
  RETURN QUERY SELECT v_lease.id, v_lease.pool_key, v_lease.task_id, v_lease.execution_id,
    v_lease.lease_owner, v_lease.lease_epoch, v_lease.cpu, v_lease.memory_bytes,
    v_lease.disk_bytes, v_lease.network, v_lease.lease_until;
END;
$fn$;

CREATE OR REPLACE FUNCTION rhinoq_task.release_resource_lease(
  p_id text, p_lease_owner text, p_lease_epoch bigint
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE v_lease rhinoq_task.resource_leases%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  IF btrim(COALESCE(p_id, '')) = '' OR btrim(COALESCE(p_lease_owner, '')) = '' OR p_lease_epoch IS NULL OR p_lease_epoch < 1 THEN
    PERFORM rhinoq_task.fail('RHINOQ_INVALID_RESOURCE_LEASE_RELEASE');
  END IF;
  SELECT * INTO v_lease FROM rhinoq_task.resource_leases WHERE resource_leases.id = p_id FOR UPDATE;
  IF NOT FOUND OR v_lease.lease_owner <> btrim(p_lease_owner) OR v_lease.lease_epoch <> p_lease_epoch THEN
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_LEASE_FENCED', p_id);
  END IF;
  IF v_lease.state = 'released' THEN RETURN; END IF;
  IF v_lease.state <> 'active' OR v_lease.lease_until <= v_now THEN
    PERFORM rhinoq_task.fail('RHINOQ_RESOURCE_LEASE_FENCED', p_id);
  END IF;
  UPDATE rhinoq_task.resource_leases
  SET state='released', lease_until=v_now, updated_at=v_now, released_at=v_now
  WHERE id=v_lease.id;
END;
$fn$;

ALTER TABLE rhinoq_task.resource_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task.resource_pools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_task_tenant_isolation ON rhinoq_task.resource_pools;
CREATE POLICY rhinoq_task_tenant_isolation ON rhinoq_task.resource_pools
  USING (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session())
  WITH CHECK (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session());

ALTER TABLE rhinoq_task.resource_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinoq_task.resource_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhinoq_task_tenant_isolation ON rhinoq_task.resource_leases;
CREATE POLICY rhinoq_task_tenant_isolation ON rhinoq_task.resource_leases
  USING (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session())
  WITH CHECK (tenant_id = rhinoq_task.current_tenant() OR rhinoq_task.maintenance_session());
`;
