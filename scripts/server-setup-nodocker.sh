#!/bin/bash
# ============================================================
# Pocket Monster Go — No-Docker Server Setup
# Installs: Node.js 20, PM2, PostgreSQL, Redis (native)
# Usage: bash scripts/server-setup-nodocker.sh
# ============================================================
set -euo pipefail

DEPLOY_DIR="/data/mineGo"
REPO_URL="https://github.com/kkcc2013-arch/mineGo.git"
NODE_VERSION="20"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  err "Cannot detect OS"
fi
log "OS: $OS $VERSION_ID ($(uname -m))"

# Must run as root
[ "$(id -u)" = "0" ] || err "Please run as root (sudo bash $0)"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   PMG Server Setup (No Docker)           ║"
echo "║   Target: $DEPLOY_DIR"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. System packages ────────────────────────────────────────
echo "── [1/8] Installing system packages..."
if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
  apt-get update -q
  apt-get install -y curl wget git build-essential python3 openssl ca-certificates gnupg lsb-release
elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "almalinux" || "$OS" == "rocky" ]]; then
  yum install -y curl wget git gcc python3 openssl ca-certificates
else
  warn "Unsupported OS: $OS — continuing anyway"
fi
log "System packages installed"

# ── 2. Node.js 20 ────────────────────────────────────────────
echo "── [2/8] Installing Node.js ${NODE_VERSION}..."
if command -v node &>/dev/null && [[ "$(node --version)" == v${NODE_VERSION}* ]]; then
  log "Node.js already at $(node --version)"
else
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
  elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "almalinux" || "$OS" == "rocky" ]]; then
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    yum install -y nodejs
  else
    # Fallback: install via nvm
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh"
    nvm install ${NODE_VERSION}
    nvm use ${NODE_VERSION}
    nvm alias default ${NODE_VERSION}
  fi
  log "Node.js installed: $(node --version)"
fi

# ── 3. PM2 ───────────────────────────────────────────────────
echo "── [3/8] Installing PM2..."
if command -v pm2 &>/dev/null; then
  log "PM2 already installed: $(pm2 --version)"
else
  npm install -g pm2
  log "PM2 installed: $(pm2 --version)"
fi

# ── 4. PostgreSQL ─────────────────────────────────────────────
echo "── [4/8] Setting up PostgreSQL..."
if command -v psql &>/dev/null; then
  log "PostgreSQL already installed: $(psql --version)"
else
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    # Add PostgreSQL apt repo for v15
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
    echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -q
    apt-get install -y postgresql-15 postgresql-15-postgis-3
  elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "almalinux" || "$OS" == "rocky" ]]; then
    yum install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-$(rpm -E %rhel)-x86_64/pgdg-redhat-repo-latest.noarch.rpm
    yum install -y postgresql15-server postgis33_15
    /usr/pgsql-15/bin/postgresql-15-setup initdb
  fi
  systemctl enable postgresql
  systemctl start postgresql
  log "PostgreSQL installed and started"
fi

# Setup DB user and database
echo "── [4b] Configuring PostgreSQL database..."
DB_PASS=$(openssl rand -base64 24 | tr -d '+/=\\' | head -c 32)
sudo -u postgres psql -tc "SELECT 1 FROM pg_user WHERE usename='pmg_user'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER pmg_user WITH PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='pmg'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE pmg OWNER pmg_user;"
sudo -u postgres psql -d pmg -c "CREATE EXTENSION IF NOT EXISTS postgis;" 2>/dev/null || \
  warn "PostGIS extension not available — location features may be limited"
sudo -u postgres psql -d pmg -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
log "PostgreSQL DB ready (user: pmg_user)"

# ── 5. Redis ─────────────────────────────────────────────────
echo "── [5/8] Setting up Redis..."
REDIS_PASS=$(openssl rand -base64 24 | tr -d '+/=\\' | head -c 24)
if command -v redis-server &>/dev/null; then
  log "Redis already installed: $(redis-server --version | head -1)"
else
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    apt-get install -y redis-server
  elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "almalinux" || "$OS" == "rocky" ]]; then
    yum install -y redis
  fi
  log "Redis installed"
fi

# Set Redis password
REDIS_CONF="/etc/redis/redis.conf"
[ -f "$REDIS_CONF" ] || REDIS_CONF="/etc/redis.conf"
if [ -f "$REDIS_CONF" ]; then
  # Set requirepass
  if grep -q "^requirepass " "$REDIS_CONF"; then
    sed -i "s/^requirepass .*/requirepass ${REDIS_PASS}/" "$REDIS_CONF"
  else
    echo "requirepass ${REDIS_PASS}" >> "$REDIS_CONF"
  fi
  # Bind to localhost only
  sed -i 's/^bind .*/bind 127.0.0.1/' "$REDIS_CONF"
  systemctl restart redis || systemctl restart redis-server || true
  log "Redis configured with password"
fi

# ── 6. Clone repo ─────────────────────────────────────────────
echo "── [6/8] Setting up project..."
mkdir -p "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/logs"
cd "$DEPLOY_DIR"

if [ -d ".git" ]; then
  git pull origin main
  log "Repo updated"
else
  git clone "$REPO_URL" .
  log "Repo cloned"
fi

# ── 7. Install Node.js dependencies ──────────────────────────
echo "── [7/8] Installing npm dependencies..."
cd "$DEPLOY_DIR/backend"

# Create shared module symlinks (relative-path workaround)
ln -sfn "$DEPLOY_DIR/backend/shared" "$DEPLOY_DIR/backend/services/shared"
ln -sfn "$DEPLOY_DIR/backend/shared" "$DEPLOY_DIR/backend/gateway/shared"
log "Shared module symlinks created"

# Install shared module deps
cd shared && npm install --omit=dev && cd ..
log "Shared deps installed"

# Install gateway deps
cd gateway && npm install --omit=dev && cd ..

# Install each service's deps
for svc in services/*/; do
  svc_name=$(basename "$svc")
  cd "$svc" && npm install --omit=dev && cd ../..
  log "  $svc_name deps installed"
done

# ── 8. Create .env ────────────────────────────────────────────
echo "── [8/8] Creating environment config..."
cd "$DEPLOY_DIR"

JWT_ACCESS=$(openssl rand -base64 32 | tr -d '+/=\\' | head -c 48)
JWT_REFRESH=$(openssl rand -base64 32 | tr -d '+/=\\' | head -c 48)

cat > .env << ENVEOF
# ── Pocket Monster Go — Production Environment ──────────────
# Generated: $(date)
NODE_ENV=production

# ── Database ─────────────────────────────────────────────────
POSTGRES_DB=pmg
POSTGRES_USER=pmg_user
POSTGRES_PASSWORD=${DB_PASS}
DATABASE_URL=postgres://pmg_user:${DB_PASS}@127.0.0.1:5432/pmg
DB_POOL_MAX=20
DB_SSL=false

# ── Redis ────────────────────────────────────────────────────
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASS}

# ── JWT ───────────────────────────────────────────────────────
JWT_ACCESS_SECRET=${JWT_ACCESS}
JWT_REFRESH_SECRET=${JWT_REFRESH}
JWT_ACCESS_TTL=24h
JWT_REFRESH_TTL=30d

# ── Ports ────────────────────────────────────────────────────
GATEWAY_PORT=8080
ADMIN_PORT=3000
ENVEOF
log ".env created"

# Load .env so the DB schema init can use correct password
export $(grep -v '^#' .env | xargs) 2>/dev/null || true

# ── Initialize database schema ────────────────────────────────
echo "── Initializing database schema..."
PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U pmg_user -d pmg \
  -f "$DEPLOY_DIR/database/migrations/V1__initial_schema.sql" 2>&1 | tail -3 || \
  warn "Schema may already exist (ok if re-running)"

PGPASSWORD="${DB_PASS}" psql -h 127.0.0.1 -U pmg_user -d pmg \
  -f "$DEPLOY_DIR/database/seeds/V2__seed_data.sql" 2>&1 | tail -3 || \
  warn "Seed data may already exist (ok if re-running)"
log "Database schema initialized"

# ── Start with PM2 ────────────────────────────────────────────
echo "── Starting services with PM2..."
cd "$DEPLOY_DIR"
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || warn "Run 'pm2 startup' manually to enable auto-start"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  PMG Setup Complete!                              ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║"
echo "║  API Gateway : http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):8080"
echo "║  Admin Panel : http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):3000"
echo "║  Health Check: http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):8080/health"
echo "║"
echo "║  Credentials saved to: $DEPLOY_DIR/.env"
echo "║"
echo "║  Commands:"
echo "║    pm2 status           — service status"
echo "║    pm2 logs             — view all logs"
echo "║    pm2 reload all       — zero-downtime reload"
echo "╚══════════════════════════════════════════════════════╝"
