# REQ-00042：基础设施即代码安全扫描与配置验证系统

- **编号**：REQ-00042
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：.github/workflows、infrastructure/k8s、Dockerfile、scripts
- **创建时间**：2026-06-09 01:05
- **依赖需求**：无

## 1. 背景与问题

当前 CI/CD 流水线（ci-cd.yml、deploy-with-rollback.yml 等）已实现完整的构建、测试、部署流程，但存在以下安全盲区：

1. **容器镜像安全缺失**：Docker 构建后直接推送，未扫描镜像中的已知漏洞（CVE）
2. **K8s 配置未验证**：YAML 配置缺少安全策略检查（如 runAsNonRoot、readOnlyRootFilesystem、drop capabilities）
3. **依赖漏洞盲区**：npm 依赖只在本地测试时检查，CI 中未集成 SCA（软件成分分析）
4. **Secret 泄露风险**：代码中可能误提交敏感信息，CI 缺少检测环节

这些问题可能导致：
- 带有高危 CVE 的镜像部署到生产环境
- K8s 配置不符合安全基线（CIS Benchmark）
- 供应链攻击风险增加

## 2. 目标

在 CI/CD 流水线中集成安全扫描与配置验证层，实现：

1. **容器镜像漏洞扫描**：阻止高危 CVE 镜像部署
2. **K8s 配置安全验证**：符合 CIS Kubernetes Benchmark 基线
3. **依赖漏洞扫描**：npm 依赖的 SCA 分析
4. **Secret 泄露检测**：防止敏感信息提交

预期收益：
- 安全左移，在 CI 阶段拦截 95%+ 的安全风险
- 满足 SOC2/ISO27001 合规审计要求
- 降低生产环境安全事件响应成本

## 3. 范围

- **包含**：
  - 添加 Trivy 容器镜像扫描步骤
  - 添加 kubeconform/kubeval K8s 配置验证
  - 添加 npm audit + Snyk 依赖漏洞扫描
  - 添加 gitleaks/trufflehog Secret 检测
  - 创建安全扫描配置文件（.trivyignore、.kubevalignore 等）
  - 更新 CI 流水线集成安全关卡
  - 添加安全扫描报告上传与归档

- **不包含**：
  - 运行时安全监控（已有 Prometheus + Jaeger）
  - WAF/防火墙配置
  - 渗透测试自动化
  - 安全培训文档

## 4. 详细需求

### 4.1 容器镜像安全扫描（Trivy）

```yaml
# .github/workflows/security-scan.yml
jobs:
  container-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.IMAGE_PREFIX }}/${{ matrix.service }}:${{ github.sha }}
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'
          exit-code: '1'  # 发现高危漏洞则失败
```

要求：
- 扫描所有 9 个服务的镜像
- 阻断 CRITICAL/HIGH 级别 CVE（允许通过 .trivyignore 临时豁免）
- 生成 SARIF 报告上传 GitHub Security Tab

### 4.2 K8s 配置安全验证

使用 kubeconform 验证所有 K8s YAML：

```yaml
jobs:
  k8s-validate:
    runs-on: ubuntu-latest
    steps:
      - name: Validate K8s manifests
        uses: instrumenta/kubeconform-action@master
        with:
          files: 'infrastructure/k8s/**/*.yaml'
          ignore_missing_schemas: true
```

添加安全策略检查（基于 kubesec）：

```bash
# 检查关键配置项
- runAsNonRoot: true
- readOnlyRootFilesystem: true
- allowPrivilegeEscalation: false
- capabilities.drop: [ALL]
- runAsUser: > 0
```

### 4.3 依赖漏洞扫描

```yaml
jobs:
  dependency-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Run npm audit
        run: npm audit --audit-level=high
        
      - name: Run Snyk security scan
        uses: snyk/actions/node@master
        with:
          args: --severity-threshold=high
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
```

### 4.4 Secret 泄露检测

```yaml
jobs:
  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 4.5 安全扫描配置文件

创建以下配置：

1. `.trivyignore` - 临时豁免的 CVE（需说明原因和计划修复时间）
2. `.snyk` - Snyk 项目配置
3. `.gitleaks.toml` - Secret 检测规则配置
4. `infrastructure/k8s/security-policy.yaml` - K8s 安全策略定义

### 4.6 CI 流水线集成

在现有 `ci-cd.yml` 的 `test` job 后、`build` job 前插入安全扫描关卡：

```
test → security-scan → build → deploy
```

任何安全扫描失败都将阻断部署。

## 5. 验收标准（可测试）

- [ ] CI 流水线包含 4 类安全扫描（容器、K8s、依赖、Secret）
- [ ] Trivy 扫描所有 9 个服务镜像，发现 HIGH/CRITICAL CVE 时构建失败
- [ ] kubeconform 验证所有 K8s YAML 文件，通过率 100%
- [ ] npm audit 检测到 HIGH 级别漏洞时构建失败
- [ ] Gitleaks 检测到潜在 Secret 泄露时构建失败
- [ ] 安全扫描报告上传至 GitHub Security Tab
- [ ] 创建 `.trivyignore`、`.gitleaks.toml` 配置文件
- [ ] 添加安全扫描单元测试（模拟漏洞检测）
- [ ] 文档更新：在 CONTRIBUTING.md 中说明安全扫描流程和豁免方式

## 6. 工作量估算

**M (Medium)** - 约 1-2 天

- 配置安全扫描工具：4h
- 集成到 CI 流水线：3h
- 创建配置文件和豁免机制：2h
- 测试验证：2h
- 文档更新：1h

## 7. 优先级理由

**P1 理由**：
1. **安全合规必要条件**：容器漏洞和配置错误是 Top 3 安全风险
2. **CI/CD 防线关键环节**：在构建阶段拦截问题，避免安全债务累积
3. **生产可用门槛**：SOC2/ISO27001 审计要求具备持续安全扫描能力
4. **影响范围可控**：仅影响 CI 流水线，不涉及业务代码变更
