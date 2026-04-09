#!/usr/bin/env bash
#
# provision-rls-role.sh — create the runtime database role used for
# Row-Level Security enforcement.
#
# Westbridge runs application queries as `westbridge_app`, which is subject
# to RLS policies (see prisma/migrations/20260318_add_row_level_security and
# 20260409060845_cortex_and_user_scoped_rls). Migrations are run as the
# schema-owning role (`postgres` locally, the Fly Postgres app role in prod)
# via `MIGRATION_DATABASE_URL` so DDL still works.
#
# The script is idempotent — it can be re-run any time. It will create the
# role if missing, refresh the password if --rotate-password is passed, and
# (re-)apply the GRANTS so that newly added tables become writable.
#
# Usage:
#   ./scripts/provision-rls-role.sh                       # local dev (uses defaults)
#   PGHOST=staging-db.fly.dev ./scripts/provision-rls-role.sh --remote
#   ./scripts/provision-rls-role.sh --rotate-password
#
# Required env (with sensible local defaults):
#   PGHOST     (default: localhost)
#   PGPORT     (default: 5432)
#   PGUSER     (default: postgres)         — must be the schema owner
#   PGPASSWORD (default: postgres)
#   PGDATABASE (default: westbridge)
#
# After this runs, set DATABASE_URL in your runtime env to:
#   postgresql://westbridge_app:<password>@<host>:<port>/<db>?schema=public
# and set MIGRATION_DATABASE_URL to the existing schema-owner URL.

set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-westbridge}"
export PGHOST PGPORT PGUSER PGDATABASE

ROTATE=0
for arg in "$@"; do
  case "$arg" in
    --rotate-password) ROTATE=1 ;;
    --remote)          : ;; # informational; no-op, just gates user expectation
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "${PGPASSWORD:-}" ]]; then
  if [[ "$PGHOST" == "localhost" || "$PGHOST" == "127.0.0.1" ]]; then
    export PGPASSWORD="postgres"
  else
    echo "ERROR: PGPASSWORD not set and host is not localhost. Set PGPASSWORD before running." >&2
    exit 2
  fi
fi

echo "Connecting as $PGUSER to $PGHOST:$PGPORT/$PGDATABASE …"

# 1. Create the role if missing. Always NOLOGIN at first; the password +
#    LOGIN attribute is set in step 2 so we can rotate idempotently.
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'westbridge_app') THEN
    CREATE ROLE westbridge_app NOLOGIN;
    RAISE NOTICE 'Created role westbridge_app';
  ELSE
    RAISE NOTICE 'Role westbridge_app already exists, skipping CREATE';
  END IF;
END
$$;
SQL

# 2. Set / rotate the password and ensure the role can log in. Generate a
#    32-byte hex secret if --rotate-password was passed OR no
#    WESTBRIDGE_APP_PASSWORD env var is supplied (first run in local dev).
if [[ "$ROTATE" -eq 1 || -z "${WESTBRIDGE_APP_PASSWORD:-}" ]]; then
  WESTBRIDGE_APP_PASSWORD="$(openssl rand -hex 32)"
  echo "Generated new password for westbridge_app — store this in your secrets manager:"
  echo "  WESTBRIDGE_APP_PASSWORD=$WESTBRIDGE_APP_PASSWORD"
fi

psql -v ON_ERROR_STOP=1 -v password="$WESTBRIDGE_APP_PASSWORD" <<'SQL'
ALTER ROLE westbridge_app LOGIN;
ALTER ROLE westbridge_app PASSWORD :'password';
SQL

# 3. Grants. Idempotent — re-running just refreshes them.
psql -v ON_ERROR_STOP=1 <<'SQL'
GRANT CONNECT ON DATABASE westbridge TO westbridge_app;
GRANT USAGE ON SCHEMA public TO westbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO westbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO westbridge_app;

-- Default privileges for any FUTURE tables created by the schema owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO westbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO westbridge_app;
SQL

# 4. Sanity: confirm the role does NOT have BYPASSRLS. This is the entire
#    point of the role split — if BYPASSRLS is on, RLS is moot.
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  has_bypass BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = 'westbridge_app';
  IF has_bypass THEN
    RAISE EXCEPTION 'westbridge_app has BYPASSRLS — refusing to continue. Run: ALTER ROLE westbridge_app NOBYPASSRLS;';
  END IF;
END
$$;
SQL

echo
echo "Done. westbridge_app is provisioned, has SELECT/INSERT/UPDATE/DELETE on every"
echo "current and future table in the public schema, can NOT run DDL, and does NOT"
echo "bypass RLS."
echo
echo "Next steps:"
echo "  1. Set DATABASE_URL in your runtime env to use westbridge_app + the password above."
echo "  2. Set MIGRATION_DATABASE_URL to the existing schema-owner URL."
echo "  3. Run \`prisma migrate deploy\` (uses MIGRATION_DATABASE_URL)."
echo "  4. Run the integration test suite: vitest run src/__tests__/integration/tenant-isolation.integration.test.ts"
