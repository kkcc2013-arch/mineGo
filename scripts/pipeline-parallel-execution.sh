#!/bin/bash
# Pipeline Parallel Execution Script
# 自动生成的并行执行脚本
# 
# REQ-00287: CI/CD 管道执行依赖分析与并行优化系统

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs/pipeline"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/execution_$TIMESTAMP.log"

# 创建日志目录
mkdir -p "$LOG_DIR"

# 日志函数
log() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_info() {
    log "${BLUE}ℹ ${NC}$1"
}

log_success() {
    log "${GREEN}✓ ${NC}$1"
}

log_warning() {
    log "${YELLOW}⚠ ${NC}$1"
}

log_error() {
    log "${RED}✗ ${NC}$1"
}

# 检查依赖
check_dependencies() {
    log_info "检查依赖..."
    
    if ! command -v gh &> /dev/null; then
        log_error "GitHub CLI (gh) 未安装"
        log_info "请访问 https://cli.github.com/ 安装"
        exit 1
    fi
    
    if ! gh auth status &> /dev/null; then
        log_error "GitHub CLI 未认证"
        log_info "请运行: gh auth login"
        exit 1
    fi
    
    log_success "依赖检查通过"
}

# 获取当前分支
get_current_branch() {
    if [ -n "$GITHUB_REF" ]; then
        echo "${GITHUB_REF#refs/heads/}"
    else
        git rev-parse --abbrev-ref HEAD
    fi
}

# 并行执行工作流
execute_parallel() {
    local workflows=("$@")
    local branch="$BRANCH"
    
    log_info "并行执行 ${#workflows[@]} 个工作流: ${workflows[*]}"
    
    local pids=()
    for workflow in "${workflows[@]}"; do
        log_info "启动: $workflow"
        (gh workflow run "$workflow" --ref "$branch" > "$LOG_DIR/${workflow%.yml}_$TIMESTAMP.log" 2>&1) &
        pids+=($!)
    done
    
    # 等待所有后台进程
    for i in "${!pids[@]}"; do
        if wait "${pids[$i]}"; then
            log_success "完成: ${workflows[$i]}"
        else
            log_error "失败: ${workflows[$i]}"
        fi
    done
}

# 串行执行工作流
execute_sequential() {
    local workflow="$1"
    local branch="$BRANCH"
    
    log_info "串行执行: $workflow"
    
    if gh workflow run "$workflow" --ref "$branch"; then
        log_success "启动成功: $workflow"
        
        # 等待工作流完成
        log_info "等待工作流完成..."
        local run_id=$(gh run list --workflow="$workflow" --limit=1 --json databaseId --jq '.[0].databaseId')
        
        if [ -n "$run_id" ]; then
            gh run watch "$run_id" --exit-status
            log_success "工作流完成: $workflow"
        fi
    else
        log_error "启动失败: $workflow"
        return 1
    fi
}

# 主函数
main() {
    log_info "🚀 Pipeline 并行执行开始"
    log_info "项目根目录: $PROJECT_ROOT"
    log_info "日志文件: $LOG_FILE"
    
    check_dependencies
    
    BRANCH=$(get_current_branch)
    log_info "当前分支: $BRANCH"
    
    # 分析依赖关系
    log_info "分析工作流依赖关系..."
    
    cd "$PROJECT_ROOT"
    
    # Level 0 - 可并行执行的工作流（无依赖）
    log_info "执行 Level 0 工作流..."
    LEVEL_0_WORKFLOWS=(
        "ci-cd.yml"
        "security-scan.yml"
        "dependency-check.yml"
    )
    execute_parallel "${LEVEL_0_WORKFLOWS[@]}"
    
    # Level 1 - 依赖 Level 0 的工作流
    log_info "执行 Level 1 工作流..."
    LEVEL_1_WORKFLOWS=(
        "integration-test.yml"
        "performance-tests.yml"
    )
    execute_parallel "${LEVEL_1_WORKFLOWS[@]}"
    
    # Level 2 - 依赖 Level 1 的工作流
    log_info "执行 Level 2 工作流..."
    LEVEL_2_WORKFLOWS=(
        "e2e-tests.yml"
        "contract-tests.yml"
    )
    execute_parallel "${LEVEL_2_WORKFLOWS[@]}"
    
    # Level 3 - 最终部署
    log_info "执行 Level 3 工作流..."
    execute_sequential "deploy.yml"
    
    log_success "🎉 Pipeline 并行执行完成"
    log_info "总耗时: $SECONDS 秒"
    log_info "日志文件: $LOG_FILE"
}

# 参数解析
ANALYZE_ONLY=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --analyze-only)
            ANALYZE_ONLY=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --analyze-only  仅分析依赖关系，不执行"
            echo "  --dry-run       模拟执行，不实际运行工作流"
            echo "  --help          显示帮助信息"
            exit 0
            ;;
        *)
            log_error "未知选项: $1"
            exit 1
            ;;
    esac
done

if [ "$ANALYZE_ONLY" = true ]; then
    log_info "仅分析模式"
    node "$PROJECT_ROOT/backend/jobs/pipelineDependencyAnalyzer.js"
    exit 0
fi

if [ "$DRY_RUN" = true ]; then
    log_info "模拟执行模式"
    log_info "将执行以下工作流层级:"
    log_info "Level 0: ci-cd.yml, security-scan.yml, dependency-check.yml (并行)"
    log_info "Level 1: integration-test.yml, performance-tests.yml (并行)"
    log_info "Level 2: e2e-tests.yml, contract-tests.yml (并行)"
    log_info "Level 3: deploy.yml (串行)"
    exit 0
fi

# 执行主函数
main "$@"
