# Deployment Runbook — Fly.io

## Prerequisites

- [Fly CLI](https://fly.io/docs/flyctl/install/) installed
- Fly.io account with organization set up
- PostgreSQL and Redis provisioned on Fly.io (or external)

## Initial Setup (one-time)

```bash
# Create the app (from Westbridge-ERP-2 root)
fly launch --no-deploy

# Create PostgreSQL database
fly postgres create --name westbridge-db --region iad

# Attach database to app
fly postgres attach westbridge-db

# Create Redis (Upstash on Fly.io)
fly redis create --name westbridge-redis --region iad

# Set secrets
fly secrets set \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  CSRF_SECRET="$(openssl rand -hex 32)" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  ERPNEXT_URL="https://your-erpnext-instance.com" \
  ERPNEXT_API_KEY="your-key" \
  ERPNEXT_API_SECRET="your-secret" \
  RESEND_API_KEY="re_xxxxx" \
  FRONTEND_URL="https://your-frontend-domain.com" \
  POWERTRANZ_ID="your-powertranz-id" \
  POWERTRANZ_PASSWORD="your-powertranz-password" \
  POWERTRANZ_TEST_MODE="false"
```

## Deploy

```bash
# Deploy from main branch
fly deploy

# Deploy specific commit
fly deploy --image-ref <commit-sha>

# Monitor deployment
fly monitor
```

## Post-Deploy

```bash
# Run database migrations
fly ssh console -C "npx prisma migrate deploy"

# Verify health
curl https://westbridge-api.fly.dev/api/health

# Check logs
fly logs
```

## Rollback

```bash
# List recent deployments
fly releases

# Rollback to previous release
fly deploy --image <previous-image-ref>
```

## Scaling

```bash
# Scale horizontally
fly scale count 3

# Scale vertically
fly scale vm shared-cpu-2x --memory 1024

# Auto-scaling is configured in fly.toml
```

## Monitoring

```bash
# Live logs
fly logs

# Metrics dashboard
fly dashboard

# SSH into running machine
fly ssh console
```
