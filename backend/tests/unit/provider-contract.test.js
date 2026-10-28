'use strict';
const http = require('http');
const express = require('express');
const Joi = require('joi');
const {ContractSchema} = require('../../shared/contract/ContractSchema');
const Runner = require('../contract/ProviderContractTestRunner');
const ContractRegistry = require('../../shared/contract/ContractRegistry');

describe('Provider contract runner with actual HTTP', () => {
  let server, baseUrl, contract;
  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.get('/items/:id', (req, res) => res.json({id: req.params.id}));
    app.post('/items', (req, res) => res.status(201).json({id: req.body.id}));
    app.get('/bad', (_req, res) => res.status(503).json({id: 123}));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    contract = new ContractSchema('fixture', '1.0.0');
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });
  const response = Joi.object({id: Joi.string().required()});

  it('validates real response, status, request body and path parameters', async () => {
    contract.defineEndpoint({method: 'GET', path: '/items/:id', response});
    contract.defineEndpoint({method: 'POST', path: '/items', request: response, response, expectedStatus: 201});
    const runner = new Runner({baseUrl, fixtures: {fixture: {
      'GET /items/:id': {params: {id: 'actual id'}},
      'POST /items': {body: {id: 'created'}}
    }}});
    runner.registerContract(contract);
    const results = await runner.runAll();
    expect(results.total).toBe(2);
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(0);
  });

  it('reports actual status and schema mismatches', async () => {
    contract.defineEndpoint({path: '/bad', response});
    const runner = new Runner({baseUrl}); runner.registerContract(contract);
    const results = await runner.runAll();
    expect(results.failed).toBe(1);
    expect(results.providers[0].tests[0].errors.map(error => error.type)).toEqual(['status_mismatch', 'schema_violation']);
  });

  it('rejects missing fixtures and response schemas rather than passing', async () => {
    contract.defineEndpoint({method: 'POST', path: '/items', response});
    contract.defineEndpoint({path: '/items/:id', response});
    contract.defineEndpoint({path: '/missing-schema'});
    const runner = new Runner({baseUrl}); runner.registerContract(contract);
    const results = await runner.runAll();
    expect(results.failed).toBe(3);
    expect(results.passed).toBe(0);
  });

  it('rejects invalid request fixtures', async () => {
    contract.defineEndpoint({method: 'POST', path: '/items', request: response, response});
    const runner = new Runner({baseUrl, fixtures: {fixture: {'POST /items': {body: {id: 123}}}}});
    runner.registerContract(contract);
    expect((await runner.runAll()).failed).toBe(1);
  });

  it('fails on connection errors and does not treat empty suites as success', async () => {
    const runner = new Runner({baseUrl: 'http://127.0.0.1:1'});
    await expect(runner.runAll()).rejects.toThrow('No provider contracts');
    runner.registerContract(contract);
    await expect(runner.runAll()).rejects.toThrow('No endpoints');
    contract.defineEndpoint({path: '/bad', response});
    expect((await runner.runAll()).failed).toBe(1);
  });

  it('requires a real callback for registry verification', async () => {
    const registry = new ContractRegistry(); registry.registerProvider('fixture', contract);
    await expect(registry.verifyProvider('fixture')).rejects.toThrow('real provider test runner');
  });
});
