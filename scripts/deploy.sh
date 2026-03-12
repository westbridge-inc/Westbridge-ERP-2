#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Westbridge ERP — Full Stack Deploy Script
# Usage: ./scripts/deploy.sh [--backend-only | --frontend-only | --setup]
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BACKEND_APP="westbridge-api"
FRONTEND_APP="westbridge-frontend"
REGION="iad"
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-$(cd "$BACKEND_DIR/../Westbridge-ERP-1" 2>/dev/null && pwd || echo "")}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $*"; }
err()  { echo -e "${RED}[error ]${NC} $*" >&2; }

# ── Preflight checks ────────────────────────────────────────────────────────
preflight() {
  log "Running preflight checks..."

  if ! command -v fly &>/dev/null; then
    err "Fly CLI not installed. Run: curl -L https://fly.io/install.sh | sh"
    exit 1
  fi

  if ! fly auth whoami &>/dev/null; then
    err "Not logged in to Fly.io. Run: fly auth login"
    exit 1
  fi

  ok "Fly CLI authenticated as $(fly auth whoami)"
}

# ── First-time setup ────────────────────────────────────────────────────────
setup() {
  log "Setting up infrastructure..."

  # Create apps
  log "Creating Fly apps..."
  fly apps create "$BACKEND_APP"  --org personal 2>/dev/null || warn "$BACKEND_APP already exists"
  fly apps create "$FRONTEND_APP" --org personal 2>/dev/null || warn "$FRONTEND_APP already exists"

  # Provision Postgres
  log "Provisioning PostgreSQL..."
  if fly postgres list 2>/dev/null | grep -q "westbridge-db"; then
    warn "PostgreSQL cluster westbridge-db already exists"
  else
    fly postgres create \
      --name westbridge-db \
      --region "$REGION" \
      --vm-size shared-cpu-1x \
      --initial-cluster-size 1 \
      --volume-size 10
    fly postgres attach westbridge-db --app "$BACKEND_APP"
  fi

  # Provision Redis
  log "Provisioning Redis..."
  if fly redis list 2>/dev/null | grep -q "westbridge-redis"; then
    warn "Redis instance westbridge-redis already exists"
  else
    fly redis create \
      --name westbridge-redis \
      --region "$REGION" \
      --no-replicas
    echo ""
    warn "Copy the REDIS_URL printed above and set it:"
    echo "  fly secrets set REDIS_URL=\"<paste>\" --app $BACKEND_APP"
  fi

  # Generate secrets
  log "Generating security secrets..."
  SESSION_SECRET=$(openssl rand -hex 32)
  CSRF_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)

  echo ""
  echo "──────────────────────────────────────────────────────"
  echo "Generated secrets (save these somewhere secure!):"
  echo "──────────────────────────────────────────────────────"
  echo "SESSION_SECRET=$SESSION_SECRET"
  echo "CSRF_SECRET=$CSRF_SECRET"
  echo "ENCRYPTION_KEY=$ENCRYPTION_KEY"
  echo "──────────────────────────────────────────────────────"
  echo ""

  log "Setting backend secrets..."
  fly secrets set \
    SESSION_SECRET="$SESSION_SECRET" \
    CSRF_SECRET="$CSRF_SECRET" \
    ENCRYPTION_KEY="$ENCRYPTION_KEY" \
    FRONTEND_URL="https://$FRONTEND_APP.fly.dev" \
    NEXT_PUBLIC_APP_URL="https://$FRONTEND_APP.fly.dev" \
    --app "$BACKEND_APP"

  log "Setting frontend secrets..."
  fly secrets set \
    BACKEND_URL="http://$BACKEND_APP.internal:4000" \
    NEXT_PUBLIC_API_URL="https://$BACKEND_APP.fly.dev" \
    --app "$FRONTEND_APP"

  ok "Infrastructure ready! Now set your service-specific secrets:"
  echo ""
  echo "  # ERPNext connection"
  echo "  fly secrets set ERPNEXT_URL=https://... ERPNEXT_API_KEY=... ERPNEXT_API_SECRET=... --app $BACKEND_APP"
  echo ""
  echo "  # Email (Resend)"
  echo "  fly secrets set RESEND_API_KEY=re_... --app $BACKEND_APP"
  echo ""
  echo "  # AI (optional)"
  echo "  fly secrets set ANTHROPIC_API_KEY=sk-ant-... --app $BACKEND_APP"
  echo ""
  echo "  # Observability (optional)"
  echo "  fly secrets set SENTRY_DSN=https://... --app $BACKEND_APP"
  echo "  fly secrets set NEXT_PUBLIC_SENTRY_DSN=https://... NEXT_PUBLIC_POSTHOG_KEY=phc_... --app $FRONTEND_APP"
  echo ""
  echo "Then run: ./scripts/deploy.sh"
}

# ── Deploy backend ──────────────────────────────────────────────────────────
deploy_backend() {
  log "Deploying backend ($BACKEND_APP)..."
  cd "$BACKEND_DIR"
  fly deploy --app "$BACKEND_APP"
  ok "Backend deployed!"

  # Verify health
  log "Checking backend health..."
  sleep 5
  if curl -sf "https://$BACKEND_APP.fly.dev/api/health" | grep -q "healthy"; then
    ok "Backend health check passed"
  else
    warn "Backend health check did not return healthy — check logs: fly logs --app $BACKEND_APP"
  fi
}

# ── Deploy frontend ─────────────────────────────────────────────────────────
deploy_frontend() {
  if [ -z "$FRONTEND_DIR" ]; then
    err "Frontend directory not found. Set FRONTEND_DIR=/path/to/Westbridge-ERP-1"
    exit 1
  fi

  log "Deploying frontend ($FRONTEND_APP)..."
  cd "$FRONTEND_DIR"
  fly deploy --app "$FRONTEND_APP"
  ok "Frontend deployed!"

  # Verify
  log "Checking frontend..."
  sleep 5
  STATUS=$(curl -so /dev/null -w "%{http_code}" "https://$FRONTEND_APP.fly.dev" || echo "000")
  if [ "$STATUS" = "200" ] || [ "$STATUS" = "307" ]; then
    ok "Frontend is live (HTTP $STATUS)"
  else
    warn "Frontend returned HTTP $STATUS — check logs: fly logs --app $FRONTEND_APP"
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────
case "${1:-all}" in
  --setup)
    preflight
    setup
    ;;
  --backend-only)
    preflight
    deploy_backend
    ;;
  --frontend-only)
    preflight
    deploy_frontend
    ;;
  all|"")
    preflight
    deploy_backend
    deploy_frontend
    echo ""
    ok "Full stack deployed!"
    echo "  Backend:  https://$BACKEND_APP.fly.dev"
    echo "  Frontend: https://$FRONTEND_APP.fly.dev"
    ;;
  *)
    echo "Usage: $0 [--setup | --backend-only | --frontend-only]"
    echo ""
    echo "  --setup          First-time setup (create apps, DB, Redis, secrets)"
    echo "  --backend-only   Deploy backend only"
    echo "  --frontend-only  Deploy frontend only"
    echo "  (no args)        Deploy both backend and frontend"
    exit 1
    ;;
esac
