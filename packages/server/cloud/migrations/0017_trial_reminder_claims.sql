-- Trial reminder flags become lifecycle claims. One-off: DELETE THIS FILE AND
-- ITS ENTRY IN migrate.mjs once it has run everywhere.
--
-- The trial reminders recorded each send as a tenant setting,
-- `trial_reminder_<stage>`. They now run on the lifecycle scheduler of
-- @munhq/product-kit, which records each send as a claim in `lifecycle_mail`.
-- The scheduler does not read the old flags. Without this file, a tenant that
-- got a stage under the flags would get it a second time.
--
-- For each flag, this writes the claim (product 'chat-recall', the tenant,
-- the key `trial.<stage>`) with the outcome 'sent', at the time the flag holds.
-- The message column holds the flag's name, because the flag did not record
-- which copy went out.
--
-- The table DDL is the scheduler's own, under the same advisory lock, so the
-- CREATE in the scheduler does nothing after this runs. The table has no
-- tenant column and no RLS, and tenant_settings is not RLS-walled
-- (engine/src/core/store/pg-schema.ts), so no tenant GUC is needed.
--
-- The migrate step runs before the server boots. On a new database
-- tenant_settings does not exist yet, and this copies nothing.
--
-- Idempotent: ON CONFLICT DO NOTHING keeps a claim that exists as it is.

DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('munhq.product-kit.lifecycle_mail'));
  CREATE TABLE IF NOT EXISTS lifecycle_mail (
    product    text        NOT NULL CHECK (product <> ''),
    subject    text        NOT NULL CHECK (subject <> ''),
    step       text        NOT NULL CHECK (step <> ''),
    message    text        NOT NULL,
    claim_id   uuid        NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    outcome    text,
    message_id text,
    done_at    timestamptz,
    PRIMARY KEY (product, subject, step)
  );
END
$$;

DO $$
DECLARE
  copied bigint;
BEGIN
  IF to_regclass('tenant_settings') IS NULL THEN
    RAISE NOTICE 'lifecycle_mail: no tenant_settings table, so no trial reminder flags to copy';
    RETURN;
  END IF;

  INSERT INTO lifecycle_mail (product, subject, step, message, claim_id, claimed_at, outcome, done_at)
  SELECT 'chat-recall', f.tenant, 'trial.' || substr(f.key, length('trial_reminder_') + 1), f.key,
         gen_random_uuid(), f.at, 'sent', f.at
    FROM (
      SELECT tenant, key,
             -- The sweep wrote Date.now() as the value: milliseconds since the epoch.
             CASE WHEN value ~ '^[0-9]{10,16}$' THEN to_timestamp(value::bigint / 1000.0) ELSE now() END AS at
        FROM tenant_settings
       WHERE key IN ('trial_reminder_nudge', 'trial_reminder_half', 'trial_reminder_final', 'trial_reminder_ended')
         AND tenant <> ''
    ) f
  ON CONFLICT (product, subject, step) DO NOTHING;

  GET DIAGNOSTICS copied = ROW_COUNT;
  RAISE NOTICE 'lifecycle_mail: % claim(s) copied from trial reminder flags', copied;
END
$$;
