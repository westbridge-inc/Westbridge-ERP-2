# Database Role Configuration

## Production Setup

For defense-in-depth, create a restricted PostgreSQL role for the application instead of using the superuser.

### 1. Create the application role

```sql
-- Run as superuser (postgres)
CREATE ROLE westbridge_app LOGIN PASSWORD 'your-secure-password';
GRANT CONNECT ON DATABASE westbridge TO westbridge_app;
GRANT USAGE ON SCHEMA public TO westbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO westbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO westbridge_app;

-- Ensure future tables are also accessible
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO westbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO westbridge_app;
```

### 2. Update DATABASE_URL

```
DATABASE_URL=postgresql://westbridge_app:your-secure-password@postgres:5432/westbridge
```

### 3. Run migrations with superuser

Prisma migrations require schema-level permissions. Use the superuser for migrations only:

```bash
DATABASE_URL=postgresql://postgres:admin-password@postgres:5432/westbridge npx prisma migrate deploy
```

Then restart the app with the restricted `westbridge_app` role.

### Why this matters

The application role cannot:
- DROP or ALTER tables
- CREATE new schemas
- Access `pg_catalog` system tables
- Execute `COPY` or `pg_dump`
- Bypass Row Level Security (if enabled)

This limits the blast radius if the application is compromised.
