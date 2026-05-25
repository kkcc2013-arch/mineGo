#!/bin/bash
# ============================================================
# Pocket Monster Go — Server Setup Script
# Run this ONCE on the server to prepare the environment
# Usage: bash server-setup.sh
# ============================================================
set -euo pipefail

DEPLOY_DIR="/data/mineGo"
REPO_URL="https://github.com/kkcc2013-arch/mineGo.git"

echo "========================================"
echo "  PMG Server Setup"
echo "  Target: $DEPLOY_DIR"
echo "========================================"

# ── 1. Check OS ──────────────────────────────────────────────
echo "[1/8] Checking OS..."
grep -E "^(NAME|VERSION)=" /etc/os-release || true
uname -m

# ── 2. Install Docker ────────────────────────────────────────
echo "[2/8] Installing Docker..."
if command -v docker &>/dev/null; then
  echo "  Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "  Docker installed: $(docker --version)"
fi

# ── 3. Install Docker Compose plugin ────────────────────────
echo "[3/8] Checking Docker Compose..."
if docker compose version &>/dev/null; then
  echo "  Docker Compose: $(docker compose version)"
else
  mkdir -p /usr/local/lib/docker/cli-plugins
  COMPOSE_VER="v2.27.0"
  curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VER}/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  echo "  Docker Compose installed: $(docker compose version)"
fi

# ── 4. Install Git ───────────────────────────────────────────
echo "[4/8] Checking Git..."
if command -v git &>/dev/null; then
  echo "  Git: $(git --version)"
else
  apt-get update -q && apt-get install -y git 2>/dev/null || \
  yum install -y git 2>/dev/null || \
  echo "Please install git manually"
fi

# ── 5. Create deploy directory & clone ──────────────────────
echo "[5/8] Setting up repo at $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"

if [ -d ".git" ]; then
  echo "  Repo exists, pulling latest..."
  git pull origin main
else
  git clone "$REPO_URL" .
  echo "  Repo cloned"
fi

# ── 6. Generate strong secrets ──────────────────────────────
echo "[6/8] Generating secrets..."
DB_PASS=$(openssl rand -base64 24 | tr -d '+/=' | head -c 32)
REDIS_PASS=$(openssl rand -base64 24 | tr -d '+/=' | head -c 24)
JWT_ACCESS=$(openssl rand -base64 32 | tr -d '+/=' | head -c 48)
JWT_REFRESH=$(openssl rand -base64 32 | tr -d '+/=' | head -c 48)

# ── 7. Create .env ───────────────────────────────────────────
echo "[7/8] Creating .env..."
if [ ! -f ".env" ]; then
cat > .env << ENVEOF
# ── Pocket Monster Go — Production Environment ──────────────
NODE_ENV=production

# ── Database ─────────────────────────────────────────────────
POSTGRES_DB=pmg
POSTGRES_USER=pmg_user
POSTGRES_PASSWORD=${DB_PASS}
DATABASE_URL=postgres://pmg_user:${DB_PASS}@postgres:5432/pmg
DB_POOL_MAX=20

# ── Redis ────────────────────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASS}

# ── JWT Secrets ───────────────────────────────────────────────
JWT_ACCESS_SECRET=${JWT_ACCESS}
JWT_REFRESH_SECRET=${JWT_REFRESH}
JWT_ACCESS_TTL=24h
JWT_REFRESH_TTL=30d

# ── External APIs (optional) ──────────────────────────────────
MAPBOX_TOKEN=
WEATHER_API_KEY=

# ── Ports exposed on host ─────────────────────────────────────
GATEWAY_PORT=8080
ADMIN_PORT=3000
ENVEOF
  echo "  .env created with auto-generated secrets"
  echo ""
  echo "  ⚠️  SAVE THESE SECRETS (stored in .env):"
  echo "     DB_PASS   = ${DB_PASS}"
  echo "     REDIS_PASS = ${REDIS_PASS}"
else
  echo "  .env already exists, skipping"
fi

# ── 8. Open firewall ports ───────────────────────────────────
echo "[8/8] Configuring firewall..."
if command -v ufw &>/dev/null; then
  ufw allow 8080/tcp comment "PMG Gateway" 2>/dev/null || true
  ufw allow 3000/tcp comment "PMG Admin" 2>/dev/null || true
  echo "  UFW rules added"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=8080/tcp 2>/dev/null || true
  firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
  echo "  Firewalld rules added"
else
  echo "  No firewall manager found, skipping"
fi

echo ""
echo "========================================"
echo "  ✅ Setup complete!"
echo ""
echo "  Start services:"
echo "    cd $DEPLOY_DIR"
echo "    docker compose up -d"
echo ""
echo "  Check status:"
echo "    docker compose ps"
echo "    docker compose logs -f"
echo ""
echo "  Access:"
echo "    API Gateway : http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):8080"
echo "    Admin Panel : http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):3000"
echo "    Health Check: http://$(curl -s ifconfig.me 2>/dev/null || echo SERVER_IP):8080/health"
echo "========================================"
