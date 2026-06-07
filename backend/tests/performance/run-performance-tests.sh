#!/bin/bash
#
# mineGo API 压力测试运行脚本
# 
# 用法: ./run-performance-tests.sh [选项]
#
# 选项:
#   --scenario <name>   测试场景 (auth|catch|gym|payment|comprehensive|all)
#   --env <name>        环境 (local|staging)
#   --output <dir>      输出目录
#   --report            生成 HTML 报告

set -e

# 默认配置
SCENARIO="comprehensive"
ENVIRONMENT="local"
OUTPUT_DIR="./performance-results"
GENERATE_REPORT=false

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --scenario)
      SCENARIO="$2"
      shift 2
      ;;
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --report)
      GENERATE_REPORT=true
      shift
      ;;
    *)
      echo "未知选项: $1"
      exit 1
      ;;
  esac
done

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  mineGo API 压力测试${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "场景: ${GREEN}${SCENARIO}${NC}"
echo -e "环境: ${GREEN}${ENVIRONMENT}${NC}"
echo -e "输出: ${GREEN}${OUTPUT_DIR}${NC}"
echo ""

# 检查 k6 是否安装
if ! command -v k6 &> /dev/null; then
  echo -e "${RED}错误: k6 未安装${NC}"
  echo ""
  echo "请安装 k6:"
  echo "  macOS:   brew install k6"
  echo "  Linux:   sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C4914C66B1E1"
  echo "           echo 'deb https://dl.k6.io/deb stable main' | sudo tee /etc/apt/sources.list.d/k6.list"
  echo "           sudo apt-get update && sudo apt-get install k6"
  echo "  Windows: choco install k6"
  echo ""
  echo "或访问: https://k6.io/docs/getting-started/installation/"
  exit 1
fi

echo -e "${GREEN}✓ k6 已安装: $(k6 version)${NC}"

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 设置环境变量
export BASE_URL="http://localhost:8080"
if [ "$ENVIRONMENT" = "staging" ]; then
  export BASE_URL="http://staging.minego.example.com"
fi

# 检查服务健康状态
echo ""
echo -e "${YELLOW}检查服务健康状态...${NC}"
if curl -s -f "$BASE_URL/health" > /dev/null; then
  echo -e "${GREEN}✓ 服务健康检查通过${NC}"
else
  echo -e "${RED}✗ 服务健康检查失败: $BASE_URL/health${NC}"
  echo ""
  echo "请确保服务已启动:"
  echo "  docker compose up -d"
  echo "  或"
  echo "  cd backend && npm run dev"
  exit 1
fi

# 运行测试的函数
run_test() {
  local test_name=$1
  local test_file=$2
  local timestamp=$(date +%Y%m%d_%H%M%S)
  local output_file="$OUTPUT_DIR/${test_name}_${timestamp}.json"
  local summary_file="$OUTPUT_DIR/${test_name}_${timestamp}_summary.txt"

  echo ""
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}  运行测试: ${test_name}${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""

  # 运行 k6 测试
  k6 run \
    --out json="$output_file" \
    --summary-export="$summary_file" \
    "$test_file"

  local exit_code=$?
  
  if [ $exit_code -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ 测试完成: ${test_name}${NC}"
    echo -e "  结果: ${output_file}"
    echo -e "  摘要: ${summary_file}"
  else
    echo ""
    echo -e "${RED}✗ 测试失败: ${test_name}${NC}"
    return $exit_code
  fi
}

# 根据场景运行测试
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case $SCENARIO in
  auth)
    run_test "auth" "$SCRIPT_DIR/auth-stress.js"
    ;;
  catch)
    run_test "catch" "$SCRIPT_DIR/catch-stress.js"
    ;;
  gym)
    run_test "gym" "$SCRIPT_DIR/gym-stress.js"
    ;;
  payment)
    run_test "payment" "$SCRIPT_DIR/payment-stress.js"
    ;;
  comprehensive)
    run_test "comprehensive" "$SCRIPT_DIR/comprehensive-stress.js"
    ;;
  all)
    run_test "auth" "$SCRIPT_DIR/auth-stress.js"
    run_test "catch" "$SCRIPT_DIR/catch-stress.js"
    run_test "gym" "$SCRIPT_DIR/gym-stress.js"
    run_test "payment" "$SCRIPT_DIR/payment-stress.js"
    run_test "comprehensive" "$SCRIPT_DIR/comprehensive-stress.js"
    ;;
  *)
    echo -e "${RED}未知场景: ${SCENARIO}${NC}"
    echo "可用场景: auth, catch, gym, payment, comprehensive, all"
    exit 1
    ;;
esac

# 生成报告
if [ "$GENERATE_REPORT" = true ]; then
  echo ""
  echo -e "${YELLOW}生成 HTML 报告...${NC}"
  
  # 查找最新的测试结果
  LATEST_RESULT=$(ls -t "$OUTPUT_DIR"/*.json | head -1)
  
  if [ -n "$LATEST_RESULT" ]; then
    node "$SCRIPT_DIR/report-generator.js" "$LATEST_RESULT" --output "$OUTPUT_DIR" --environment "$ENVIRONMENT"
    echo -e "${GREEN}✓ 报告已生成${NC}"
  fi
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  压力测试完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "结果保存在: $OUTPUT_DIR"
echo ""
echo "查看报告:"
echo "  open $OUTPUT_DIR/report-*.html"
