# REQ-00241：软件物料清单（SBOM）生成与供应链安全验证系统

- **编号**：REQ-00241
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend/shared、所有微服务、infrastructure/k8s
- **创建时间**：2026-06-16 02:10
- **依赖需求**：REQ-00222（CI/CD 构建缓存优化与依赖供应链安全验证系统）

## 1. 背景与问题

当前 mineGo 项目的 CI/CD 流水线已经实现了容器镜像扫描（Trivy）、依赖漏洞检查（npm audit、Snyk）、密钥泄露检测（Gitleaks）等安全措施，但缺少**软件物料清单（Software Bill of Materials, SBOM）**生成与供应链安全验证环节。

具体问题包括：
1. **缺乏依赖透明度**：无法清晰了解每个镜像/构建中包含的所有第三方组件及其版本信息
2. **供应链攻击风险**：近年来 SolarWinds、Codecov 等供应链攻击频发，缺少源头验证机制
3. **合规要求**：美国行政令 EO 14028 要求软件供应商提供 SBOM，GDPR/CCPA 也对数据处理的第三方组件有审计要求
4. **漏洞溯源困难**：当某个依赖发现漏洞时（如 Log4j、lodash），难以快速定位受影响的服务和版本
5. **构建完整性验证缺失**：无法验证构建产物是否被篡改，缺少 provenance 和 attestation

## 2. 目标

建立一个完整的软件供应链安全体系，实现：
- 自动生成符合 SPDX/CycloneDX 标准的 SBOM
- 对每个构建产物签名并生成 SLSA provenance（Supply-chain Levels for Software Artifacts）
- 建立依赖项白名单和黑名单机制
- 在漏洞披露后 1 小时内能快速识别受影响服务
- 满足 NIST SSDF（Secure Software Development Framework）合规要求

## 3. 范围

### 包含
- SBOM 生成与存储（每个镜像、每个 npm 包）
- SBOM 格式标准化（SPDX 2.3 和 CycloneDX 1.5）
- Cosign 签名与 SLSA provenance 生成
- 依赖项许可证合规检查（GPL/AGPL/LGPL 检测）
- SBOM 持续监控与漏洞关联
- 依赖项准入控制（白名单/黑名单）
- GitHub Actions 工作流集成
- admin-dashboard SBOM 查询界面

### 不包含
- 第三方 SaaS SBOM 管理平台集成（如 Dependency-Track）
- 运行时依赖监控（如 OpenTelemetry Dependency Profiling）
- 私有 npm 仓库安全扫描（项目使用公共 npm 仓库）

## 4. 详细需求

### 4.1 SBOM 生成器

```javascript
// backend/shared/SBOMGenerator.js
class SBOMGenerator {
  constructor(options = {}) {
    this.format = options.format || 'spdx'; // spdx | cyclonedx
    this.outputDir = options.outputDir || './sbom';
  }

  // 从 package-lock.json 和 node_modules 生成 SBOM
  async generateFromPackage(servicePath) {
    const packageLock = require(path.join(servicePath, 'package-lock.json'));
    const sbom = {
      bomFormat: this.format === 'spdx' ? 'SPDX-2.3' : 'CycloneDX-1.5',
      components: [],
      dependencies: {}
    };

    // 提取所有依赖项信息
    for (const [name, info] of Object.entries(packageLock.packages || {})) {
      if (name === '') continue; // 跳过根包
      sbom.components.push({
        type: 'library',
        name: name.replace('node_modules/', ''),
        version: info.version,
        purl: `pkg:npm/${name.replace('node_modules/', '')}@${info.version}`,
        licenses: await this.detectLicense(name, info.version),
        hashes: {
          sha256: await this.computeHash(name)
        },
        supplier: info.resolved ? new URL(info.resolved).hostname : 'unknown',
        properties: [
          { name: 'npm:integrity', value: info.integrity }
        ]
      });
    }

    return sbom;
  }

  // 许可证检测
  async detectLicense(packageName, version) {
    const licenseMap = {
      'MIT': 'MIT',
      'Apache-2.0': 'Apache-2.0',
      'BSD-2-Clause': 'BSD-2-Clause',
      'BSD-3-Clause': 'BSD-3-Clause',
      'ISC': 'ISC',
      'GPL-3.0': 'GPL-3.0', // 需要审核
      'AGPL-3.0': 'AGPL-3.0', // 禁止使用
      'LGPL-3.0': 'LGPL-3.0'  // 需要审核
    };
    // 从 npm registry 获取许可证信息
    const metadata = await fetch(`https://registry.npmjs.org/${packageName}/${version}`);
    const data = await metadata.json();
    return data.license ? { id: licenseMap[data.license] || data.license } : { id: 'NOASSERTION' };
  }

  // 计算 SHA256 哈希
  async computeHash(packageName) {
    const crypto = require('crypto');
    const packagePath = path.join('node_modules', packageName);
    const files = await this.listFiles(packagePath);
    const hash = crypto.createHash('sha256');
    for (const file of files) {
      const content = await fs.readFile(file);
      hash.update(content);
    }
    return hash.digest('hex');
  }

  // 导出到文件
  async export(sbom, format = 'json') {
    const filename = `sbom-${Date.now()}.${this.format}.${format}`;
    const filepath = path.join(this.outputDir, filename);
    if (format === 'json') {
      await fs.writeJson(filepath, sbom, { spaces: 2 });
    } else if (format === 'xml') {
      await fs.writeFile(filepath, this.toXML(sbom));
    }
    return filepath;
  }
}

module.exports = SBOMGenerator;
```

### 4.2 Cosign 签名与 SLSA Provenance

```yaml
# .github/workflows/sbom-sign.yml
name: SBOM Generation & Signing

on:
  push:
    branches: [main, develop]
  workflow_dispatch:

jobs:
  generate-sbom:
    name: 📦 Generate SBOM
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Syft (SBOM generator)
        run: |
          curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin

      - name: Install Cosign (signing tool)
        uses: sigstore/cosign-installer@v3

      - name: Generate SBOM for each service
        run: |
          mkdir -p sbom-output
          SERVICES="user-service location-service pokemon-service catch-service gym-service social-service reward-service payment-service api-gateway"
          for svc in $SERVICES; do
            echo "Generating SBOM for $svc..."
            syft packages dir:backend/services/${svc} \
              --output spdx-json=sbom-output/${svc}-spdx.json \
              --output cyclonedx-json=sbom-output/${svc}-cyclonedx.json
          done

      - name: Sign SBOMs with Cosign
        env:
          COSIGN_PRIVATE_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}
          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}
        run: |
          for file in sbom-output/*.json; do
            cosign sign-blob --key env://COSIGN_PRIVATE_KEY \
              --output-signature ${file}.sig \
              --yes \
              ${file}
          done

      - name: Generate SLSA provenance
        uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v1.9.0
        with:
          base64-subjects: |
            ${{ steps.generate-sbom.outputs.sha256-digest }}

      - name: Upload SBOM artifacts
        uses: actions/upload-artifact@v4
        with:
          name: sbom-attestations
          path: |
            sbom-output/*.json
            sbom-output/*.sig
            sbom-output/*.intoto.jsonl

      - name: Attach SBOM to container images
        env:
          REGISTRY: registry.cn-shanghai.aliyuncs.com
          IMAGE_PREFIX: registry.cn-shanghai.aliyuncs.com/pmg
        run: |
          SHORT_SHA=$(echo ${{ github.sha }} | head -c 7)
          SERVICES="user-service location-service pokemon-service catch-service gym-service social-service reward-service payment-service api-gateway"
          for svc in $SERVICES; do
            IMAGE="${IMAGE_PREFIX}/${svc}:${SHORT_SHA}"
            SBOM_FILE="sbom-output/${svc}-spdx.json"
            
            # Attach SBOM as attestation
            cosign attest --predicate ${SBOM_FILE} \
              --type spdx \
              --key env://COSIGN_PRIVATE_KEY \
              ${IMAGE} || echo "Image not yet pushed, skipping"
          done

  license-compliance-check:
    name: ⚖️ License Compliance
    runs-on: ubuntu-latest
    needs: generate-sbom
    steps:
      - uses: actions/checkout@v4

      - name: Download SBOM artifacts
        uses: actions/download-artifact@v4
        with:
          name: sbom-attestations
          path: sbom-output

      - name: Check for forbidden licenses
        run: |
          FORBIDDEN_LICENSES="AGPL-3.0 AGPL-3.0-only AGPL-3.0-or-later GPL-3.0 GPL-3.0-only GPL-3.0-or-later"
          
          for file in sbom-output/*-spdx.json; do
            echo "Checking $file..."
            for license in $FORBIDDEN_LICENSES; do
              if grep -q "\"licenseId\": \"$license\"" "$file"; then
                echo "::error file=$file::Forbidden license detected: $license"
                exit 1
              fi
            done
          done
          
          echo "✅ All licenses compliant"

  dependency-whitelist-check:
    name: ✅ Dependency Whitelist Check
    runs-on: ubuntu-latest
    needs: generate-sbom
    steps:
      - uses: actions/checkout@v4

      - name: Download SBOM artifacts
        uses: actions/download-artifact@v4
        with:
          name: sbom-attestations
          path: sbom-output

      - name: Check against dependency whitelist
        run: |
          node scripts/check-dependency-whitelist.js sbom-output/
```

### 4.3 依赖项白名单/黑名单管理

```javascript
// scripts/check-dependency-whitelist.js
const fs = require('fs');
const path = require('path');

class DependencyPolicyChecker {
  constructor() {
    // 白名单：经过审核的安全依赖
    this.whitelist = require('./dependency-whitelist.json');
    
    // 黑名单：禁止使用的依赖（已知漏洞、许可证问题等）
    this.blacklist = require('./dependency-blacklist.json');
  }

  async checkSBOM(sbomPath) {
    const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
    const violations = [];

    for (const component of sbom.components || []) {
      const { name, version } = component;

      // 检查黑名单
      if (this.blacklist[name]) {
        const bannedVersions = this.blacklist[name].versions || [];
        if (bannedVersions.includes(version) || bannedVersions.includes('*')) {
          violations.push({
            type: 'blacklist',
            name,
            version,
            reason: this.blacklist[name].reason,
            severity: this.blacklist[name].severity || 'high'
          });
        }
      }

      // 检查白名单
      if (!this.whitelist[name]) {
        violations.push({
          type: 'unapproved',
          name,
          version,
          reason: 'Dependency not in whitelist',
          severity: 'medium'
        });
      }
    }

    return violations;
  }

  generateReport(violations, outputPath) {
    const report = {
      timestamp: new Date().toISOString(),
      totalViolations: violations.length,
      summary: {
        blacklist: violations.filter(v => v.type === 'blacklist').length,
        unapproved: violations.filter(v => v.type === 'unapproved').length
      },
      violations
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    return report;
  }
}

// 执行检查
if (require.main === module) {
  const checker = new DependencyPolicyChecker();
  const sbomDir = process.argv[2] || './sbom-output';
  
  const files = fs.readdirSync(sbomDir).filter(f => f.endsWith('-spdx.json'));
  const allViolations = [];

  for (const file of files) {
    const violations = await checker.checkSBOM(path.join(sbomDir, file));
    allViolations.push(...violations.map(v => ({ ...v, file })));
  }

  const report = checker.generateReport(allViolations, './dependency-violations.json');
  
  if (report.totalViolations > 0) {
    console.error(`❌ Found ${report.totalViolations} dependency violations`);
    process.exit(1);
  } else {
    console.log('✅ All dependencies compliant');
  }
}

module.exports = DependencyPolicyChecker;
```

### 4.4 漏洞快速溯源

```javascript
// backend/shared/VulnerabilityCorrelator.js
class VulnerabilityCorrelator {
  constructor(sbomStorage) {
    this.sbomStorage = sbomStorage; // Redis 或 PostgreSQL
  }

  // 当 CVE 披露时，快速查找受影响服务
  async findAffectedServices(cveId, packageName, affectedVersions) {
    const services = [];
    const allSBOMs = await this.sbomStorage.getAll();

    for (const [serviceName, sbom] of Object.entries(allSBOMs)) {
      const component = sbom.components.find(c => 
        c.name === packageName && 
        this.isVersionAffected(c.version, affectedVersions)
      );
      
      if (component) {
        services.push({
          serviceName,
          packageName,
          version: component.version,
          cveId,
          severity: await this.getCVESeverity(cveId),
          remediation: await this.getRemediation(packageName, affectedVersions)
        });
      }
    }

    return services.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  isVersionAffected(version, affectedRanges) {
    const semver = require('semver');
    return affectedRanges.some(range => semver.satisfies(version, range));
  }

  async getCVESeverity(cveId) {
    // 从 NVD API 查询
    const response = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId}`);
    const data = await response.json();
    return data.vulnerabilities[0]?.cve?.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity?.toLowerCase() || 'unknown';
  }

  async getRemediation(packageName, affectedVersions) {
    return {
      action: 'upgrade',
      targetVersion: await this.findPatchedVersion(packageName, affectedVersions)
    };
  }
}

module.exports = VulnerabilityCorrelator;
```

### 4.5 SBOM 存储与查询 API

```javascript
// backend/shared/SBOMStorage.js
const { Pool } = require('pg');
const Redis = require('ioredis');

class SBOMStorage {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = new Redis(process.env.REDIS_URL);
  }

  // 存储 SBOM
  async store(serviceName, version, sbom) {
    const client = await this.db.connect();
    try {
      await client.query(`
        INSERT INTO sbom_registry (service_name, version, sbom_json, sbom_format, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (service_name, version) 
        DO UPDATE SET sbom_json = $3, updated_at = NOW()
      `, [serviceName, version, JSON.stringify(sbom), sbom.bomFormat]);

      // 缓存到 Redis（1小时）
      await this.redis.setex(
        `sbom:${serviceName}:${version}`,
        3600,
        JSON.stringify(sbom)
      );
    } finally {
      client.release();
    }
  }

  // 查询 SBOM
  async get(serviceName, version) {
    // 先查 Redis
    const cached = await this.redis.get(`sbom:${serviceName}:${version}`);
    if (cached) return JSON.parse(cached);

    // 查数据库
    const result = await this.db.query(
      'SELECT sbom_json FROM sbom_registry WHERE service_name = $1 AND version = $2',
      [serviceName, version]
    );

    if (result.rows.length > 0) {
      return result.rows[0].sbom_json;
    }
    return null;
  }

  // 按包名搜索
  async findByPackage(packageName) {
    const result = await this.db.query(`
      SELECT service_name, version, sbom_json->'components' as components
      FROM sbom_registry
      WHERE sbom_json::text LIKE $1
    }, [`%"name": "${packageName}"%`]);

    return result.rows.map(row => ({
      serviceName: row.service_name,
      version: row.version,
      packageVersion: row.components.find(c => c.name === packageName)?.version
    }));
  }
}

module.exports = SBOMStorage;
```

### 4.6 数据库迁移

```sql
-- database/migrations/20260616000000_create_sbom_registry.sql
CREATE TABLE IF NOT EXISTS sbom_registry (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  version VARCHAR(50) NOT NULL,
  sbom_json JSONB NOT NULL,
  sbom_format VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(service_name, version)
);

CREATE INDEX idx_sbom_service ON sbom_registry(service_name);
CREATE INDEX idx_sbom_created ON sbom_registry(created_at DESC);
CREATE INDEX idx_sbom_components ON sbom_registry USING GIN (sbom_json);

-- 存储签名和 provenance
CREATE TABLE IF NOT EXISTS sbom_attestations (
  id SERIAL PRIMARY KEY,
  sbom_id INTEGER REFERENCES sbom_registry(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  public_key TEXT NOT NULL,
  provenance JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dependency_violations (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  package_name VARCHAR(200) NOT NULL,
  package_version VARCHAR(50) NOT NULL,
  violation_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  reason TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_violations_service ON dependency_violations(service_name);
CREATE INDEX idx_violations_unresolved ON dependency_violations(service_name) 
  WHERE resolved_at IS NULL;
```

## 5. 验收标准（可测试）

- [ ] 每次构建自动生成 SPDX 2.3 和 CycloneDX 1.5 格式的 SBOM
- [ ] 所有 SBOM 使用 Cosign 签名并生成 SLSA Level 3 provenance
- [ ] SBOM 作为 attestation 附加到容器镜像
- [ ] 检测到 AGPL/GPL/LGPL 许可证时构建失败
- [ ] 黑名单依赖（已知漏洞包）阻断构建
- [ ] 新依赖不在白名单时发出警告（不阻断）
- [ ] 漏洞披露后能通过 API 在 5 秒内查询所有受影响服务
- [ ] admin-dashboard 提供 SBOM 查询界面
- [ ] SBOM 存储在 PostgreSQL 并缓存到 Redis
- [ ] 满足 NIST SSDF PO.3.3（软件物料清单）要求

## 6. 工作量估算

**L（Large）**

理由：
- 需要集成多个工具链（Syft、Cosign、SLSA）
- 需要建立完整的依赖项白名单/黑名单体系
- 需要设计数据库 schema 和存储逻辑
- 需要开发 admin-dashboard 界面
- 需要编写完整的单元测试和集成测试
- 需要与现有 CI/CD 流水线深度集成

预计工时：5-7 个工作日

## 7. 优先级理由

**P1（高优先级）**

1. **合规要求**：美国 EO 14028 要求软件供应商提供 SBOM，GDPR/CCPA 对第三方组件有审计要求
2. **安全必要性**：供应链攻击频发（SolarWinds、Codecov），是当前安全领域的重大风险
3. **漏洞响应效率**：Log4j、lodash 等漏洞披露时，能快速定位受影响服务，减少 MTTR
4. **依赖透明度**：为未来引入更多第三方组件奠定基础，避免"依赖黑盒"风险
5. **技术债务预防**：早期建立 SBOM 体系比后期补救成本低得多

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 白名单维护成本高 | 中 | 自动化白名单生成 + 定期审核 |
| 签名密钥管理复杂 | 高 | 使用 KMS 或 GitHub Secrets 管理 |
| 构建时间增加 | 中 | 并行生成 SBOM + 增量更新 |
| 镜像存储成本增加 | 低 | 定期清理历史 SBOM（保留最近 10 个版本） |

## 9. 相关文档

- SPDX Specification 2.3: https://spdx.github.io/spdx-spec/
- CycloneDX Specification 1.5: https://cyclonedx.org/specification/overview/
- SLSA Framework: https://slsa.dev/
- NIST SSDF: https://csrc.nist.gov/pubs/sp/800/218/final
- Cosign Documentation: https://docs.sigstore.dev/cosign/signing/signing_with_containers/
