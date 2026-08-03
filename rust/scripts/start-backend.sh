#!/usr/bin/env bash
# Start Postgres + Redis + API for local dev (macOS Homebrew or Docker)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!>\033[0m %s\n' "$*"; }

start_postgres() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log "Starting postgres via Docker..."
    docker compose up -d postgres
    export DATABASE_URL="${DATABASE_URL:-postgresql://noetis:noetis@localhost:5432/noetis}"
    return
  fi

  if brew list postgresql@16 >/dev/null 2>&1 || brew list postgresql >/dev/null 2>&1; then
    PG="$(brew --prefix postgresql@16 2>/dev/null || brew --prefix postgresql)"
    export PATH="$PG/bin:$PATH"
    if ! pg_isready -q 2>/dev/null; then
      log "Starting Postgres (Homebrew)..."
      brew services start postgresql@16 2>/dev/null || brew services start postgresql
      sleep 2
    fi
    createdb noetis 2>/dev/null || true
    psql postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='noetis'" | grep -q 1 || \
      psql postgres -c "CREATE USER noetis WITH PASSWORD 'noetis' CREATEDB;"
    psql postgres -tc "SELECT 1 FROM pg_database WHERE datname='noetis'" | grep -q 1 || \
      psql postgres -c "CREATE DATABASE noetis OWNER noetis;"
    psql -d noetis -c "GRANT ALL ON SCHEMA public TO noetis;" 2>/dev/null || true
    psql -d noetis -c "ALTER SCHEMA public OWNER TO noetis;" 2>/dev/null || true
    export DATABASE_URL="${DATABASE_URL:-postgresql://noetis:noetis@localhost:5432/noetis}"
    return
  fi

  warn "Postgres not found. Install one of:"
  echo "  brew install postgresql@16 && brew services start postgresql@16"
  echo "  docker compose up -d postgres"
  exit 1
}

start_redis() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker compose up -d redis 2>/dev/null || true
    export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
    return
  fi

  if command -v redis-cli >/dev/null 2>&1; then
    if ! redis-cli ping >/dev/null 2>&1; then
      log "Starting Redis (Homebrew)..."
      brew services start redis
      sleep 1
    fi
    export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
    return
  fi

  if brew list redis >/dev/null 2>&1; then
    brew services start redis
    sleep 1
    export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
    return
  fi

  warn "Redis not found. Install: brew install redis && brew services start redis"
  exit 1
}

log "Noetis backend startup"
start_postgres
start_redis

log "Building packages..."
npm run build -w @noetis/protocol -w @noetis/crypto -w @noetis/currency \
  -w @noetis/blockchain -w @noetis/scheduler -w @noetis/database -w @noetis/api

log "Running database migrations..."
node packages/database/dist/migrate.js

log "Starting API on :3001..."
export PORT="${PORT:-3001}"
npm run dev -w @noetis/api
