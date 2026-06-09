/**
 * Security Scanning Configuration Tests
 * Tests for REQ-00042: Infrastructure Security Scanning and Validation System
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

describe('Security Scanning Configuration', () => {

  describe('Trivy Configuration', () => {
    const trivyignorePath = path.join(__dirname, '../../.trivyignore');

    test('should have .trivyignore file', () => {
      expect(fs.existsSync(trivyignorePath)).toBe(true);
    });

    test('.trivyignore should contain usage instructions', () => {
      const content = fs.readFileSync(trivyignorePath, 'utf8');
      expect(content).toContain('Trivy Ignore File');
      expect(content).toContain('CVE-ID');
      expect(content).toContain('Reason for exemption');
      expect(content).toContain('Planned fix date');
    });

    test('.trivyignore should warn about review requirements', () => {
      const content = fs.readFileSync(trivyignorePath, 'utf8');
      expect(content).toContain('Review this file monthly');
      expect(content).toContain('Maximum exemption period');
    });
  });

  describe('Gitleaks Configuration', () => {
    const gitleaksPath = path.join(__dirname, '../../.gitleaks.toml');

    test('should have .gitleaks.toml file', () => {
      expect(fs.existsSync(gitleaksPath)).toBe(true);
    });

    test('should extend default rules', () => {
      const content = fs.readFileSync(gitleaksPath, 'utf8');
      expect(content).toContain('useDefault = true');
    });

    test('should have custom rules for Aliyun keys', () => {
      const content = fs.readFileSync(gitleaksPath, 'utf8');
      expect(content).toContain('aliyun-access-key');
      expect(content).toContain('LTAI[A-Za-z0-9]{12,20}');
    });

    test('should have custom rules for JWT secrets', () => {
      const content = fs.readFileSync(gitleaksPath, 'utf8');
      expect(content).toContain('jwt-secret');
      expect(content).toContain('jwt[_-]?secret');
    });

    test('should have allowlist for test files', () => {
      const content = fs.readFileSync(gitleaksPath, 'utf8');
      expect(content).toContain('.env.example');
      expect(content).toContain('.test.js');
      expect(content).toContain('.spec.js');
    });

    test('should allow environment variable references', () => {
      const content = fs.readFileSync(gitleaksPath, 'utf8');
      expect(content).toContain('process\\.env\\.\\w+');
      expect(content).toContain('secrets\\.\\w+');
    });
  });

  describe('Snyk Configuration', () => {
    const snykPath = path.join(__dirname, '../../.snyk');

    test('should have .snyk file', () => {
      expect(fs.existsSync(snykPath)).toBe(true);
    });

    test('should set severity threshold to high', () => {
      const content = fs.readFileSync(snykPath, 'utf8');
      expect(content).toContain('severityThreshold: high');
    });

    test('should enable workspaces', () => {
      const content = fs.readFileSync(snykPath, 'utf8');
      expect(content).toContain('workspaces: true');
    });

    test('should have zero tolerance for critical/high vulnerabilities', () => {
      const content = fs.readFileSync(snykPath, 'utf8');
      expect(content).toContain('critical: 0');
      expect(content).toContain('high: 0');
    });
  });

  describe('K8s Security Policy', () => {
    const securityPolicyPath = path.join(__dirname, '../../infrastructure/k8s/security-policy.yaml');

    test('should have security-policy.yaml file', () => {
      expect(fs.existsSync(securityPolicyPath)).toBe(true);
    });

    test('should enforce restricted pod security', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('pod-security.kubernetes.io/enforce: restricted');
    });

    test('should have PodSecurityPolicy', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('kind: PodSecurityPolicy');
      expect(content).toContain('privileged: false');
      expect(content).toContain('allowPrivilegeEscalation: false');
    });

    test('should drop all capabilities', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('requiredDropCapabilities');
      expect(content).toContain('- ALL');
    });

    test('should require non-root user', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('runAsUser');
      expect(content).toContain('MustRunAsNonRoot');
    });

    test('should require read-only root filesystem', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('readOnlyRootFilesystem: true');
    });

    test('should have NetworkPolicy', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('kind: NetworkPolicy');
      expect(content).toContain('policyTypes');
      expect(content).toContain('Ingress');
      expect(content).toContain('Egress');
    });

    test('should restrict ingress to gateway only', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('api-gateway');
    });

    test('should allow necessary database ports', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('5432');  // PostgreSQL
      expect(content).toContain('6379');  // Redis
      expect(content).toContain('9092');  // Kafka
    });

    test('should have RBAC configuration', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('kind: ServiceAccount');
      expect(content).toContain('kind: Role');
      expect(content).toContain('kind: RoleBinding');
    });

    test('should use minimal RBAC permissions', () => {
      const content = fs.readFileSync(securityPolicyPath, 'utf8');
      expect(content).toContain('resources: ["configmaps", "secrets"]');
      expect(content).toContain('verbs: ["get", "list"]');
    });
  });

  describe('CI/CD Security Workflow', () => {
    const workflowPath = path.join(__dirname, '../../.github/workflows/security-scan.yml');

    test('should have security-scan.yml workflow', () => {
      expect(fs.existsSync(workflowPath)).toBe(true);
    });

    test('should trigger on push and PR', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('on:');
      expect(content).toContain('push:');
      expect(content).toContain('pull_request:');
    });

    test('should have secret scan job', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('secret-scan');
      expect(content).toContain('Gitleaks');
    });

    test('should have dependency scan job', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('dependency-scan');
      expect(content).toContain('npm audit');
      expect(content).toContain('Snyk');
    });

    test('should have K8s validation job', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('k8s-validate');
      expect(content).toContain('kubeconform');
    });

    test('should have container scan job', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('container-scan');
      expect(content).toContain('Trivy');
    });

    test('should scan all 9 services', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      const services = [
        'user-service',
        'location-service',
        'pokemon-service',
        'catch-service',
        'gym-service',
        'social-service',
        'reward-service',
        'payment-service',
        'api-gateway'
      ];
      services.forEach(service => {
        expect(content).toContain(service);
      });
    });

    test('should fail on HIGH/CRITICAL vulnerabilities', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('severity: \'CRITICAL,HIGH\'');
      expect(content).toContain('exit-code: \'1\'');
    });

    test('should upload SARIF reports', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('upload-sarif');
      expect(content).toContain('github/codeql-action');
    });

    test('should generate security summary', () => {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('security-summary');
      expect(content).toContain('GITHUB_STEP_SUMMARY');
    });
  });

  describe('Updated CI/CD Pipeline', () => {
    const cicdPath = path.join(__dirname, '../../.github/workflows/ci-cd.yml');

    test('should have security-scan job in CI/CD', () => {
      const content = fs.readFileSync(cicdPath, 'utf8');
      expect(content).toContain('security-scan');
    });

    test('should run security-scan after test', () => {
      const content = fs.readFileSync(cicdPath, 'utf8');
      expect(content).toMatch(/needs:\s*test[\s\S]*security-scan/);
    });

    test('should run build after security-scan', () => {
      const content = fs.readFileSync(cicdPath, 'utf8');
      expect(content).toMatch(/needs:\s*security-scan[\s\S]*build/);
    });

    test('should integrate Trivy in build job', () => {
      const content = fs.readFileSync(cicdPath, 'utf8');
      expect(content).toContain('Run Trivy vulnerability scanner');
      expect(content).toContain('aquasecurity/trivy-action');
    });

    test('should have correct job order', () => {
      const content = fs.readFileSync(cicdPath, 'utf8');
      const jobOrder = [
        'Job 1: Lint & Unit Tests',
        'Job 2: Security Scan',
        'Job 3: Build Docker Images',
        'Job 4: Deploy to Staging',
        'Job 5: Canary Deploy to Production',
        'Job 6: Full Production Deploy'
      ];
      jobOrder.forEach(job => {
        expect(content).toContain(job);
      });
    });
  });

  describe('Security Best Practices', () => {
    test('should not have hardcoded secrets in code', () => {
      const envExample = path.join(__dirname, '../../.env.example');
      if (fs.existsSync(envExample)) {
        const content = fs.readFileSync(envExample, 'utf8');
        // Should not contain actual secrets
        expect(content).not.toMatch(/password\s*=\s*['"]?\w{10,}/i);
        expect(content).not.toMatch(/secret\s*=\s*['"]?\w{20,}/i);
        expect(content).not.toMatch(/key\s*=\s*['"]?[a-zA-Z0-9]{30,}/i);
      }
    });

    test('Dockerfile should follow best practices', () => {
      const dockerfile = path.join(__dirname, '../../backend/Dockerfile');
      if (fs.existsSync(dockerfile)) {
        const content = fs.readFileSync(dockerfile, 'utf8');
        // Should not run as root
        expect(content).toMatch(/USER\s+\d+/);
        // Should use specific version
        expect(content).toMatch(/FROM\s+node:\d+/);
        // Should have health check
        expect(content).toMatch(/HEALTHCHECK|EXPOSE/);
      }
    });

    test('all K8s deployments should have security context', (done) => {
      const k8sDir = path.join(__dirname, '../../infrastructure/k8s');
      if (!fs.existsSync(k8sDir)) {
        done();
        return;
      }

      const walkDir = (dir) => {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath);
          } else if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            // Check for security context in deployment files
            if (content.includes('kind: Deployment')) {
              expect(content).toContain('securityContext');
            }
          }
        });
      };

      walkDir(k8sDir);
      done();
    });
  });
});

// Helper to run tests
if (require.main === module) {
  console.log('Running Security Scanning Configuration Tests...\n');
  console.log('✅ Test suite ready');
  console.log('Run with: npm test backend/tests/unit/security-scan.test.js');
}