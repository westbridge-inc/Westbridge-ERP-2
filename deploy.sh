#!/bin/bash
set -euo pipefail

echo "═══════════════════════════════════════════════════════"
echo "  Westbridge ERP — Production Deploy (Docker Compose)"
echo "═══════════════════════════════════════════════════════"

# ── Check prerequisites ────────────────────────────────────────────────────
if [ ! -f .env.production ]; then
  echo "ERROR: Missing .env.production"
  echo "  Copy .env.production.example to .env.production and fill in values."
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is not installed."
  exit 1
fi

# ── Build and start services ──────────────────────────────────────────────
echo ""
echo "[1/3] Building and starting services..."
docker compose -f docker-compose.production.yml --env-file .env.production up -d --build

# ── Wait for database to be ready ────────────────────────────────────────
echo ""
echo "[2/3] Waiting for database..."
sleep 3

# ── Run migrations ────────────────────────────────────────────────────────
echo ""
echo "[3/3] Running database migrations..."
docker compose -f docker-compose.production.yml exec api npx prisma migrate deploy

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Deploy complete. API running on port 4000"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Health check: curl http://localhost:4000/api/health"
echo "  Logs:         docker compose -f docker-compose.production.yml logs -f api"
echo "  Stop:         docker compose -f docker-compose.production.yml down"
