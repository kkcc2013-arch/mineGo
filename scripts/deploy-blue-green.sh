#!/bin/bash
# ============================================================
# Blue-Green Deployment Script for mineGo
# ============================================================
# Usage:
#   ./scripts/deploy-blue-green.sh deploy <service> <image-tag>
#   ./scripts/deploy-blue-green.sh verify <service>
#   ./scripts/deploy-blue-green.sh switch <service>
#   ./scripts/deploy-blue-green.sh rollback <service>
#   ./scripts/deploy-blue-green.sh status [service]
#   ./scripts/deploy-blue-green.sh scale-down-inactive <service>
#   ./scripts/deploy-blue-green.sh deploy-all <image-tag>
#   ./scripts/deploy-blue-green.sh switch-all

set -euo pipefail

# Configuration
NAMESPACE="pmg"
REGISTRY="registry.cn-shanghai.aliyuncs.com/pmg"
SERVICES="api-gateway user-service location-service pokemon-service catch-service gym-service social-service reward-service payment-service"
DEPLOY_STATE_CM="deploy-state"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================
# Helper Functions
# ============================================================

get_active_version() {
    local service=$1
    local active=$(kubectl get configmap $DEPLOY_STATE_CM -n $NAMESPACE -o jsonpath='{.data.'$service'-active}' 2>/dev/null || echo "blue")
    echo "$active"
}

set_active_version() {
    local service=$1
    local version=$2
    local commit=${3:-$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")}
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    kubectl get configmap $DEPLOY_STATE_CM -n $NAMESPACE >/dev/null 2>&1 || \
        kubectl create configmap $DEPLOY_STATE_CM -n $NAMESPACE
    
    kubectl patch configmap $DEPLOY_STATE_CM -n $NAMESPACE --type=merge \
        -p "{\"data\":{\"$service-active\":\"$version\",\"$service-commit\":\"$commit\",\"$service-deployed-at\":\"$timestamp\"}}"
}

wait_for_deployment() {
    local deployment=$1
    local timeout=${2:-300}
    
    log_info "Waiting for $deployment to be ready (timeout: ${timeout}s)..."
    
    if kubectl rollout status deployment/$deployment -n $NAMESPACE --timeout=${timeout}s; then
        log_success "$deployment is ready"
        return 0
    else
        log_error "$deployment failed to become ready within ${timeout}s"
        return 1
    fi
}

verify_health() {
    local service=$1
    local version=$2
    local port=${SERVICE_PORTS[$service]:-8080}
    
    local deployment="${service}-${version}"
    
    log_info "Verifying health of $deployment..."
    
    # Check deployment exists and has replicas
    local ready_replicas=$(kubectl get deployment $deployment -n $NAMESPACE -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    local desired_replicas=$(kubectl get deployment $deployment -n $NAMESPACE -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
    
    if [[ "$ready_replicas" != "$desired_replicas" ]] || [[ "$ready_replicas" == "0" ]]; then
        log_error "Deployment $deployment has $ready_replicas/$desired_replicas ready replicas"
        return 1
    fi
    
    log_success "Health check passed for $deployment ($ready_replicas replicas ready)"
    return 0
}

# Service port mapping
declare -A SERVICE_PORTS=(
    ["api-gateway"]=8080
    ["user-service"]=8081
    ["location-service"]=8082
    ["pokemon-service"]=8083
    ["catch-service"]=8084
    ["gym-service"]=8085
    ["social-service"]=8086
    ["reward-service"]=8087
    ["payment-service"]=8088
)

# ============================================================
# Commands
# ============================================================

cmd_deploy() {
    local service=$1
    local image_tag=$2
    
    local active=$(get_active_version $service)
    local target="green"
    [[ "$active" == "green" ]] && target="blue"
    
    log_info "Deploying $service to $target environment (current: $active)"
    log_info "Image: $REGISTRY/$service:$image_tag"
    
    local deployment="${service}-${target}"
    local port=${SERVICE_PORTS[$service]:-8080}
    
    # Check if deployment exists
    if ! kubectl get deployment $deployment -n $NAMESPACE >/dev/null 2>&1; then
        log_info "Creating new deployment $deployment..."
        
        kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $deployment
  namespace: $NAMESPACE
  labels:
    app: $service
    version: $target
spec:
  replicas: 2
  selector:
    matchLabels:
      app: $service
      version: $target
  template:
    metadata:
      labels:
        app: $service
        version: $target
    spec:
      containers:
        - name: $service
          image: $REGISTRY/$service:$image_tag
          imagePullPolicy: Always
          ports:
            - containerPort: $port
              name: http
          envFrom:
            - configMapRef: { name: pmg-config }
            - secretRef: { name: pmg-secrets }
          env:
            - { name: PORT, value: "$port" }
          resources:
            requests: { cpu: "100m", memory: "128Mi" }
            limits: { cpu: "500m", memory: "512Mi" }
          livenessProbe:
            httpGet: { path: /health, port: $port }
            initialDelaySeconds: 15
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /health, port: $port }
            initialDelaySeconds: 5
            periodSeconds: 5
EOF
    else
        # Update existing deployment
        log_info "Updating deployment $deployment..."
        kubectl set image deployment/$deployment $service=$REGISTRY/$service:$image_tag -n $NAMESPACE
        kubectl scale deployment $deployment --replicas=2 -n $NAMESPACE 2>/dev/null || true
    fi
    
    # Wait for deployment
    wait_for_deployment $deployment
    
    log_success "Deployed $service to $target environment"
    log_info "Run './scripts/deploy-blue-green.sh verify $service' to verify, then './scripts/deploy-blue-green.sh switch $service' to switch traffic"
}

cmd_verify() {
    local service=$1
    
    local active=$(get_active_version $service)
    local inactive="green"
    [[ "$active" == "green" ]] && inactive="blue"
    
    log_info "Verifying $service (active: $active, inactive: $inactive)"
    
    # Verify active is still healthy
    verify_health $service $active || {
        log_error "Active version $active is unhealthy!"
        return 1
    }
    
    # Verify inactive is ready for switch
    verify_health $service $inactive || {
        log_error "Inactive version $inactive is not ready"
        return 1
    }
    
    # Run smoke tests if available
    if [[ -x "./scripts/smoke-test.sh" ]]; then
        log_info "Running smoke tests on $inactive..."
        ./scripts/smoke-test.sh $service $inactive || {
            log_error "Smoke tests failed for $inactive"
            return 1
        }
    fi
    
    log_success "$service verification passed - ready to switch"
}

cmd_switch() {
    local service=$1
    
    local active=$(get_active_version $service)
    local target="green"
    [[ "$active" == "green" ]] && target="blue"
    
    log_info "Switching $service from $active to $target..."
    
    # Verify target is healthy before switch
    verify_health $service $target || {
        log_error "Target version $target is not healthy - aborting switch"
        return 1
    }
    
    # Update service selector
    kubectl patch service $service -n $NAMESPACE --type='json' \
        -p="[{\"op\":\"replace\",\"path\":\"/spec/selector/version\",\"value\":\"$target\"}]" 2>/dev/null || \
    kubectl patch service $service -n $NAMESPACE --type='merge' \
        -p "{\"spec\":{\"selector\":{\"app\":\"$service\",\"version\":\"$target\"}}}"
    
    # Wait for endpoint update
    sleep 2
    
    # Update state
    set_active_version $service $target
    
    log_success "Traffic switched to $target for $service"
    
    # Send notification if configured
    if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-type: application/json' \
            -d "{\"text\":\"🚀 Blue-Green Deploy: $service switched to $target\"}" || true
    fi
}

cmd_rollback() {
    local service=$1
    
    local active=$(get_active_version $service)
    local target="blue"
    [[ "$active" == "blue" ]] && target="green"
    
    log_warn "Rolling back $service from $active to $target..."
    
    # Check if target deployment exists and has replicas
    local replicas=$(kubectl get deployment ${service}-${target} -n $NAMESPACE -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
    
    if [[ "$replicas" == "0" ]]; then
        log_warn "Scaling up $target..."
        kubectl scale deployment ${service}-${target} --replicas=2 -n $NAMESPACE
        wait_for_deployment ${service}-${target}
    fi
    
    # Switch back
    cmd_switch $service
}

cmd_scale_down_inactive() {
    local service=$1
    
    local active=$(get_active_version $service)
    local inactive="green"
    [[ "$active" == "green" ]] && inactive="blue"
    
    log_info "Scaling down $inactive for $service..."
    
    kubectl scale deployment ${service}-${inactive} --replicas=1 -n $NAMESPACE || true
    
    log_success "Scaled down $inactive to 1 replica (kept for quick rollback)"
}

cmd_status() {
    local service=${1:-all}
    
    echo ""
    echo "========================================="
    echo "  Blue-Green Deployment Status"
    echo "========================================="
    echo ""
    
    if [[ "$service" != "all" ]]; then
        show_service_status $service
        return
    fi
    
    for svc in $SERVICES; do
        show_service_status $svc
    done
    
    echo "========================================="
}

show_service_status() {
    local service=$1
    local active=$(get_active_version $service)
    local commit=$(kubectl get configmap $DEPLOY_STATE_CM -n $NAMESPACE -o jsonpath='{.data.'$service'-commit}' 2>/dev/null || echo "N/A")
    
    local blue_replicas=$(kubectl get deployment ${service}-blue -n $NAMESPACE -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    local green_replicas=$(kubectl get deployment ${service}-green -n $NAMESPACE -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    
    local blue_status="inactive"
    local green_status="inactive"
    [[ "$active" == "blue" ]] && blue_status="ACTIVE"
    [[ "$active" == "green" ]] && green_status="ACTIVE"
    
    printf "%-20s | Commit: %-10s | Blue: %-8s (%s) | Green: %-8s (%s)\n" \
        "$service" "$commit" "${blue_replicas}r" "$blue_status" "${green_replicas}r" "$green_status"
}

cmd_deploy_all() {
    local image_tag=$1
    
    for svc in $SERVICES; do
        log_info "Deploying $svc..."
        cmd_deploy $svc $image_tag || log_error "Failed to deploy $svc"
    done
    
    log_success "All services deployed"
}

cmd_switch_all() {
    for svc in $SERVICES; do
        log_info "Switching $svc..."
        cmd_switch $svc || log_error "Failed to switch $svc"
    done
    
    log_success "All services switched"
}

# ============================================================
# Main
# ============================================================

show_usage() {
    echo "Blue-Green Deployment Script for mineGo"
    echo ""
    echo "Usage: $0 <command> [arguments]"
    echo ""
    echo "Commands:"
    echo "  deploy <service> <image-tag>  Deploy new version to inactive environment"
    echo "  verify <service>              Verify inactive environment is healthy"
    echo "  switch <service>              Switch production traffic to inactive env"
    echo "  rollback <service>            Rollback to previous version"
    echo "  status [service]              Show deployment status"
    echo "  scale-down-inactive <service> Scale down inactive environment to 1 replica"
    echo "  deploy-all <image-tag>        Deploy all services"
    echo "  switch-all                    Switch all services"
    echo ""
    echo "Services: $SERVICES"
    echo ""
    echo "Examples:"
    echo "  $0 deploy catch-service v1.2.3"
    echo "  $0 verify catch-service"
    echo "  $0 switch catch-service"
    echo "  $0 rollback catch-service"
    echo "  $0 status"
}

# Parse command
command=${1:-help}
shift || true

case $command in
    deploy)
        [[ $# -lt 2 ]] && { log_error "Usage: $0 deploy <service> <image-tag>"; exit 1; }
        cmd_deploy "$1" "$2"
        ;;
    verify)
        [[ $# -lt 1 ]] && { log_error "Usage: $0 verify <service>"; exit 1; }
        cmd_verify "$1"
        ;;
    switch)
        [[ $# -lt 1 ]] && { log_error "Usage: $0 switch <service>"; exit 1; }
        cmd_switch "$1"
        ;;
    rollback)
        [[ $# -lt 1 ]] && { log_error "Usage: $0 rollback <service>"; exit 1; }
        cmd_rollback "$1"
        ;;
    status)
        cmd_status "${1:-all}"
        ;;
    scale-down-inactive)
        [[ $# -lt 1 ]] && { log_error "Usage: $0 scale-down-inactive <service>"; exit 1; }
        cmd_scale_down_inactive "$1"
        ;;
    deploy-all)
        [[ $# -lt 1 ]] && { log_error "Usage: $0 deploy-all <image-tag>"; exit 1; }
        cmd_deploy_all "$1"
        ;;
    switch-all)
        cmd_switch_all
        ;;
    help|--help|-h)
        show_usage
        ;;
    *)
        log_error "Unknown command: $command"
        show_usage
        exit 1
        ;;
esac
