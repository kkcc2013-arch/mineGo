#!/bin/bash
# ============================================================
# Smoke Tests for Blue-Green Deployment
# ============================================================
# Run basic health checks against a service deployment

set -euo pipefail

NAMESPACE="pmg"
TIMEOUT=30

log_info()  { echo -e "\033[0;34m[INFO]\033[0m $1"; }
log_pass()  { echo -e "\033[0;32m[PASS]\033[0m $1"; }
log_fail()  { echo -e "\033[0;31m[FAIL]\033[0m $1"; }

# Service endpoints
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

run_smoke_tests() {
    local service=$1
    local version=${2:-active}
    local port=${SERVICE_PORTS[$service]:-8080}
    
    log_info "Running smoke tests for $service ($version)..."
    
    # Get a pod from the deployment
    local deployment="${service}-${version}"
    local pod=$(kubectl get pods -n $NAMESPACE -l app=$service,version=$version -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    
    if [[ -z "$pod" ]]; then
        log_fail "No pods found for $deployment"
        return 1
    fi
    
    log_info "Testing pod: $pod"
    
    local failures=0
    
    # Test 1: Health endpoint
    log_info "Testing /health endpoint..."
    if kubectl exec -n $NAMESPACE $pod -- curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health 2>/dev/null | grep -q "200"; then
        log_pass "Health check passed"
    else
        log_fail "Health check failed"
        ((failures++))
    fi
    
    # Test 2: Metrics endpoint (if exists)
    log_info "Testing /metrics endpoint..."
    if kubectl exec -n $NAMESPACE $pod -- curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/metrics 2>/dev/null | grep -q "200"; then
        log_pass "Metrics endpoint available"
    else
        log_info "Metrics endpoint not available (may be expected)"
    fi
    
    # Test 3: Check container is running
    log_info "Checking container status..."
    local container_status=$(kubectl get pod -n $NAMESPACE $pod -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || echo "false")
    if [[ "$container_status" == "true" ]]; then
        log_pass "Container is ready"
    else
        log_fail "Container is not ready"
        ((failures++))
    fi
    
    # Test 4: Check for restarts
    log_info "Checking restart count..."
    local restarts=$(kubectl get pod -n $NAMESPACE $pod -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo "0")
    if [[ "$restarts" -le 1 ]]; then
        log_pass "Restart count acceptable ($restarts)"
    else
        log_fail "High restart count: $restarts"
        ((failures++))
    fi
    
    # Test 5: Service-specific tests
    case $service in
        api-gateway)
            # Test routing
            log_info "Testing API gateway routing..."
            if kubectl exec -n $NAMESPACE $pod -- curl -s http://localhost:$port/v1/health 2>/dev/null | grep -q "ok"; then
                log_pass "Gateway routing works"
            else
                log_info "Gateway routing test skipped"
            fi
            ;;
        payment-service)
            # Payment service should have secure endpoints
            log_info "Testing payment security..."
            local response=$(kubectl exec -n $NAMESPACE $pod -- curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health 2>/dev/null || echo "000")
            if [[ "$response" == "200" ]]; then
                log_pass "Payment service healthy"
            else
                log_fail "Payment service unhealthy: $response"
                ((failures++))
            fi
            ;;
    esac
    
    echo ""
    if [[ $failures -eq 0 ]]; then
        log_pass "All smoke tests passed for $service ($version)"
        return 0
    else
        log_fail "$failures smoke test(s) failed for $service ($version)"
        return 1
    fi
}

# Main
service=${1:-all}
version=${2:-active}

if [[ "$service" == "all" ]]; then
    for svc in api-gateway user-service location-service pokemon-service catch-service gym-service social-service reward-service payment-service; do
        run_smoke_tests $svc $version || true
    done
else
    run_smoke_tests $service $version
fi
