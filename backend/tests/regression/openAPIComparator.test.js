/**
 * OpenAPI Breaking Change 检测器单元测试
 */

const { expect } = require('chai');
const OpenAPIBreakingChangeDetector = require('../../../shared/OpenAPIComparator');

describe('OpenAPIBreakingChangeDetector', function() {
  let detector;

  beforeEach(function() {
    detector = new OpenAPIBreakingChangeDetector();
  });

  describe('#compare()', function() {
    it('应检测到操作被删除', function() {
      const oldSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              operationId: 'getPokemon',
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const newSpec = {
        paths: {}
      };

      const changes = detector.compare(oldSpec, newSpec);
      const breakingChanges = detector.getBreakingChanges(changes);

      expect(breakingChanges).to.have.lengthOf(1);
      expect(breakingChanges[0].type).to.equal('OPERATION_REMOVED');
      expect(breakingChanges[0].severity).to.equal('critical');
    });

    it('应检测到参数被删除', function() {
      const oldSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              operationId: 'getPokemon',
              parameters: [
                { name: 'id', in: 'query', required: true, schema: { type: 'string' } }
              ],
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const newSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              operationId: 'getPokemon',
              parameters: [],
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const changes = detector.compare(oldSpec, newSpec);
      const paramRemoved = changes.find(c => c.type === 'PARAMETER_REMOVED');

      expect(paramRemoved).to.exist;
      expect(paramRemoved.parameter).to.equal('id');
    });

    it('应检测到参数类型变更', function() {
      const oldSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              parameters: [
                { name: 'limit', in: 'query', schema: { type: 'integer' } }
              ],
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const newSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              parameters: [
                { name: 'limit', in: 'query', schema: { type: 'string' } }
              ],
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const changes = detector.compare(oldSpec, newSpec);
      const typeChange = changes.find(c => c.type === 'PARAMETER_TYPE_CHANGED');

      expect(typeChange).to.exist;
      expect(typeChange.oldType).to.equal('integer');
      expect(typeChange.newType).to.equal('string');
    });

    it('应检测到参数从可选变为必填', function() {
      const oldSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              parameters: [
                { name: 'filter', in: 'query', required: false }
              ],
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const newSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              parameters: [
                { name: 'filter', in: 'query', required: true }
              ],
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const changes = detector.compare(oldSpec, newSpec);
      const becameRequired = changes.find(c => c.type === 'PARAMETER_BECAME_REQUIRED');

      expect(becameRequired).to.exist;
    });

    it('应检测到响应字段被删除', function() {
      const oldSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              responses: {
                200: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      };

      const newSpec = {
        paths: {
          '/api/pokemon': {
            get: {
              responses: {
                200: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      };

      const changes = detector.compare(oldSpec, newSpec);
      const propertyRemoved = changes.find(c => c.type === 'RESPONSE_PROPERTY_REMOVED');

      expect(propertyRemoved).to.exist;
      expect(propertyRemoved.property).to.equal('name');
    });

    it('应检测到新增的操作（信息级别）', function() {
      const oldSpec = {
        paths: {}
      };

      const newSpec = {
        paths: {
          '/api/new': {
            get: {
              operationId: 'newOperation',
              responses: { 200: { description: 'OK' } }
            }
          }
        }
      };

      const changes = detector.compare(oldSpec, newSpec);
      const newOp = changes.find(c => c.type === 'OPERATION_ADDED');

      expect(newOp).to.exist;
      expect(newOp.severity).to.equal('info');
    });

    it('应处理空规范', function() {
      const changes = detector.compare(null, null);
      expect(changes).to.be.an('array').with.lengthOf(0);
    });
  });

  describe('#generateReport()', function() {
    it('应生成正确的报告摘要', function() {
      const changes = [
        { type: 'OPERATION_REMOVED', severity: 'critical' },
        { type: 'PARAMETER_DEPRECATED', severity: 'warning' },
        { type: 'OPERATION_ADDED', severity: 'info' }
      ];

      const report = detector.generateReport(changes);

      expect(report.summary.total).to.equal(3);
      expect(report.summary.critical).to.equal(1);
      expect(report.summary.warning).to.equal(1);
      expect(report.summary.info).to.equal(1);
      expect(report.breakingChanges).to.have.lengthOf(1);
    });
  });

  describe('#normalizePaths()', function() {
    it('应统一路径参数格式', function() {
      const paths = {
        '/api/pokemon/:id': { get: {} },
        '/api/user/{userId}': { get: {} }
      };

      const normalized = detector.normalizePaths(paths);

      expect(normalized['/api/pokemon/{id}']).to.exist;
      expect(normalized['/api/user/{userId}']).to.exist;
    });
  });
});