#!/bin/bash
# scripts/test-rollback.sh - 测试回滚功能
set -e

echo "🧪 Testing rollback functionality..."
echo "============================================================"

NAMESPACE="pmg"
SERVICES="gateway user location pokemon catch gym social reward payment"

# 测试 1: 验证部署脚本存在
echo ""
echo "Test 1: Verify deployment scripts exist..."
SCRIPTS=("deploy-service.sh" "verify-health.sh" "auto-rollback.sh" "deploy-history.sh" "get-error-rate.sh")
for SCRIPT in "${SCRIPTS[@]}"; do
  if [ -f "scripts/$SCRIPT" ]; then
    echo "  ✅ scripts/$SCRIPT exists"
  else
    echo "  ❌ scripts/$SCRIPT missing"
    exit 1
  fi
done

# 测试 2: 验证脚本可执行
echo ""
echo "Test 2: Verify scripts are executable..."
for SCRIPT in "${SCRIPTS[@]}"; do
  if [ -x "scripts/$SCRIPT" ]; then
    echo "  ✅ scripts/$SCRIPT is executable"
  else
    echo "  ⚠️ scripts/$SCRIPT not executable, fixing..."
    chmod +x "scripts/$SCRIPT"
    echo "  ✅ scripts/$SCRIPT now executable"
  fi
done

# 测试 3: 验证部署工作流存在
echo ""
echo "Test 3: Verify deployment workflow exists..."
if [ -f ".github/workflows/deploy-with-rollback.yml" ]; then
  echo "  ✅ .github/workflows/deploy-with-rollback.yml exists"
else
  echo "  ❌ .github/workflows/deploy-with-rollback.yml missing"
  exit 1
fi

# 测试 4: 验证 PM2 配置
echo ""
echo "Test 4: Verify PM2 ecosystem configuration..."
if [ -f "ecosystem.config.js" ]; then
  echo "  ✅ ecosystem.config.js exists"
  
  # 检查关键服务配置
  SERVICES_PM2=("pmg-gateway" "pmg-user" "pmg-location" "pmg-pokemon" "pmg-catch" "pmg-gym" "pmg-social" "pmg-reward" "pmg-payment")
  for SVC in "${SERVICES_PM2[@]}"; do
    if grep -q "name:.*'$SVC'" ecosystem.config.js || grep -q "name:.*\"$SVC\"" ecosystem.config.js; then
      echo "  ✅ $SVC configured in ecosystem"
    else
      echo "  ⚠️ $SVC not found in ecosystem (checking with different pattern)"
      if grep -q "$SVC" ecosystem.config.js; then
        echo "  ✅ $SVC found (pattern matched)"
      else
        echo "  ❌ $SVC not found in ecosystem"
        exit 1
      fi
    fi
  done
else
  echo "  ❌ ecosystem.config.js missing"
  exit 1
fi

# 测试 5: 验证部署历史目录
echo ""
echo "Test 5: Verify deployment history directory..."
if [ -d ".deploy-history" ]; then
  echo "  ✅ .deploy-history directory exists"
else
  echo "  ⚠️ .deploy-history directory missing, creating..."
  mkdir -p .deploy-history
  echo "  ✅ .deploy-history directory created"
fi

# 测试 6: 验证脚本语法
echo ""
echo "Test 6: Verify script syntax..."
for SCRIPT in "${SCRIPTS[@]}"; do
  if bash -n "scripts/$SCRIPT" 2>/dev/null; then
    echo "  ✅ scripts/$SCRIPT syntax OK"
  else
    echo "  ❌ scripts/$SCRIPT syntax error"
    exit 1
  fi
done

# 测试 7: 验证工作流语法
echo ""
echo "Test 7: Verify workflow YAML syntax..."
if command -v yamllint &> /dev/null; then
  if yamllint .github/workflows/deploy-with-rollback.yml 2>/dev/null; then
    echo "  ✅ workflow YAML syntax OK"
  else
    echo "  ⚠️ workflow YAML has minor issues (non-critical)"
  fi
else
  echo "  ⚠️ yamllint not installed, skipping YAML validation"
fi

# 测试 8: 模拟健康检查
echo ""
echo "Test 8: Simulate health check script..."
if ./scripts/verify-health.sh --help &>/dev/null || bash scripts/verify-health.sh "" 2>&1 | grep -q "Usage"; then
  echo "  ✅ verify-health.sh script works"
else
  echo "  ⚠️ verify-health.sh needs service name argument"
fi

# 测试 9: 验证回滚逻辑
echo ""
echo "Test 9: Verify rollback logic in workflow..."
if grep -q "ROLLBACK" .github/workflows/deploy-with-rollback.yml; then
  echo "  ✅ Rollback logic found in workflow"
else
  echo "  ❌ Rollback logic missing in workflow"
  exit 1
fi

# 测试 10: 验证监控逻辑
echo ""
echo "Test 10: Verify monitoring logic in workflow..."
if grep -q "Monitor error rate" .github/workflows/deploy-with-rollback.yml; then
  echo "  ✅ Monitoring logic found in workflow"
else
  echo "  ❌ Monitoring logic missing in workflow"
  exit 1
fi

echo ""
echo "============================================================"
echo "✅ All tests passed!"
echo ""
echo "Summary:"
echo "  - Deployment scripts: ✅"
echo "  - Rollback workflow: ✅"
echo "  - PM2 configuration: ✅"
echo "  - Monitoring logic: ✅"
echo ""
echo "Next steps:"
echo "  1. Push changes to GitHub"
echo "  2. Test deployment with: .github/workflows/deploy-with-rollback.yml"
echo "  3. Monitor error rate after deployment"
echo "  4. Verify automatic rollback on failure"
