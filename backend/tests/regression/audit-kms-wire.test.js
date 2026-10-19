'use strict';

const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  AwsKmsKeyProvider,
  EnvironmentKeyProvider,
  providerFromEnvironment
} = require('../../shared/audit/KeyProviders');
const {
  seal,
  open,
  jsonBytes
} = require('../../shared/audit/cryptoPrimitives');
const ARN = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
const OLD = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789013';
const CONTEXT = {
  purpose: 'minego-audit-v1',
  namespace: crypto.randomBytes(32).toString('hex'),
  id: 'audit1:' + crypto.randomUUID()
};
const failure = code => error => error.code === code;

// This speaks the real SDK's HTTP protocol. It is not live AWS/KMS acceptance.
async function fixture(fn) {
  const requests = [],
    master = crypto.randomBytes(32);
  let mode = 'normal';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'),
      body = JSON.parse(raw),
      target = req.headers['x-amz-target'];
    requests.push({
      body,
      target,
      raw,
      authorization: req.headers.authorization
    });
    res.setHeader('Content-Type', 'application/x-amz-json-1.1');
    if (mode === 'deny') {
      res.statusCode = 403;
      return res.end(JSON.stringify({
        __type: 'AccessDeniedException',
        message: 'private upstream detail must not escape'
      }));
    }
    if (mode === 'timeout') return;
    let key, blob;
    try {
      if (target === 'TrentService.GenerateDataKey') {
        assert.equal(body.KeySpec, 'AES_256');
        key = crypto.randomBytes(mode === 'short' ? 31 : 32);
        blob = Buffer.from(JSON.stringify(seal(key, master, body.EncryptionContext)));
      } else {
        assert.equal(target, 'TrentService.Decrypt');
        assert.equal(body.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT');
        blob = Buffer.from(body.CiphertextBlob, 'base64');
        key = open(JSON.parse(blob.toString('utf8')), master, body.EncryptionContext);
      }
      res.end(JSON.stringify({
        KeyId: mode === 'wrong-key' ? OLD : body.KeyId,
        Plaintext: key.toString('base64'),
        CiphertextBlob: blob.toString('base64')
      }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({
        __type: 'InvalidCiphertextException',
        message: 'fixture context rejected'
      }));
    } finally {
      key?.fill(0);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const config = {
    keyId: ARN,
    decryptKeyIds: [OLD],
    nodeEnv: 'test',
    endpoint,
    credentials: {
      accessKeyId: 'fixture-only-access',
      secretAccessKey: 'fixture-only-secret'
    },
    requestTimeout: 150
  };
  const provider = new AwsKmsKeyProvider(config);
  try {
    await fn({
      provider,
      config,
      requests,
      mode: value => {
        mode = value;
      }
    });
  } finally {
    provider.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    master.fill(0);
  }
}
test('actual AWS SDK generates and unwraps through bounded signed KMS HTTP requests', async t => fixture(async ({
  provider,
  requests,
  mode
}) => {
  let generated;
  await t.test('protocol retains only wrapped material and binds the non-sensitive encryption context', async () => {
    generated = await provider.generate(CONTEXT);
    assert.equal(generated.key.length, 32);
    assert.equal(generated.wrapped.provider, 'aws-kms');
    assert.equal(generated.wrapped.masterKeyId, ARN);
    const key = await provider.unwrap(generated.wrapped, CONTEXT);
    assert.deepEqual(key, generated.key);
    key.fill(0);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.deepEqual(request.body.EncryptionContext, CONTEXT);
      assert.match(request.authorization, /^AWS4-HMAC-SHA256 Credential=fixture-only-access\//);
      assert.ok(!request.raw.includes(generated.key.toString('base64')));
    }
    await assert.rejects(provider.unwrap(generated.wrapped, {
      ...CONTEXT,
      id: 'different-row'
    }), failure('AUDIT_KMS_UNAVAILABLE'));
  });
  await t.test('denial, unavailable service, malformed keys and mismatched ARN never return plaintext', async () => {
    mode('deny');
    await assert.rejects(provider.generate(CONTEXT), error => failure('AUDIT_KMS_UNAVAILABLE')(error) && !String(error).includes('upstream'));
    await assert.rejects(provider.unwrap(generated.wrapped, CONTEXT), failure('AUDIT_KMS_UNAVAILABLE'));
    mode('short');
    await assert.rejects(provider.generate(CONTEXT), failure('AUDIT_KMS_RESPONSE_INVALID'));
    mode('wrong-key');
    await assert.rejects(provider.generate(CONTEXT), failure('AUDIT_KMS_RESPONSE_INVALID'));
    await assert.rejects(provider.unwrap(generated.wrapped, CONTEXT), failure('AUDIT_KMS_RESPONSE_INVALID'));
    mode('timeout');
    const start = Date.now();
    await assert.rejects(provider.generate(CONTEXT), failure('AUDIT_KMS_UNAVAILABLE'));
    assert.ok(Date.now() - start < 3000);
    mode('normal');
    const before = requests.length;
    for (const wrapped of [{
      ...generated.wrapped,
      masterKeyId: 'unknown'
    }, {
      ...generated.wrapped,
      ciphertext: 'not canonical base64'
    }, {
      ...generated.wrapped,
      ciphertext: ''
    }, {
      ...generated.wrapped,
      provider: 'environment'
    }, {
      ...generated.wrapped,
      v: 2
    }]) await assert.rejects(provider.unwrap(wrapped, CONTEXT), failure('AUDIT_KEY_ENVELOPE_INVALID'));
    assert.equal(requests.length, before);
    generated.key.fill(0);
  });
}));
test('provider configuration fails closed without files, fallback credentials or production endpoint overrides', async () => {
  const master = crypto.randomBytes(32);
  const hex = master.toString('hex');
  for (const config of [{}, {
    NODE_ENV: 'production',
    MASTER_ENCRYPTION_KEY: hex
  }, {
    MASTER_ENCRYPTION_KEY: 'bad'
  }, {
    AUDIT_MASTER_KEYS_JSON: 'not-json'
  }, {
    AUDIT_MASTER_KEYS_JSON: '[]'
  }, {
    MASTER_ENCRYPTION_KEY: hex,
    AUDIT_MASTER_KEYS_JSON: JSON.stringify({
      'env-primary': 'different'
    })
  }]) assert.throws(() => providerFromEnvironment(config));
  assert.throws(() => new EnvironmentKeyProvider({
    keys: {
      a: master
    },
    activeKeyId: 'a',
    nodeEnv: 'production'
  }));
  for (const config of [{
    keyId: 'alias/not-pinned'
  }, {
    keyId: ARN,
    region: 'eu-west-1'
  }, {
    keyId: ARN,
    decryptKeyIds: 'not-array'
  }, {
    keyId: ARN,
    requestTimeout: 0
  }, {
    keyId: ARN,
    endpoint: 'https://example.invalid',
    nodeEnv: 'test'
  }, {
    keyId: ARN,
    endpoint: 'http://user:pass@localhost',
    nodeEnv: 'test'
  }, {
    keyId: ARN,
    endpoint: 'http://localhost',
    nodeEnv: 'production'
  }]) assert.throws(() => new AwsKmsKeyProvider(config));
  const provider = providerFromEnvironment({
    MASTER_ENCRYPTION_KEY: hex,
    NODE_ENV: 'test'
  });
  try {
    const value = await provider.generate(CONTEXT);
    assert.deepEqual(await provider.unwrap(value.wrapped, CONTEXT), value.key);
    value.key.fill(0);
  } finally {
    provider.close();
    master.fill(0);
  }
  const kms = providerFromEnvironment({
    NODE_ENV: 'production',
    AUDIT_KMS_KEY_ID: ARN,
    AUDIT_KMS_DECRYPT_KEY_IDS: JSON.stringify([OLD]),
    AWS_REGION: 'us-east-1'
  });
  kms.close();
  assert.throws(() => providerFromEnvironment({
    AUDIT_KMS_KEY_ID: ARN,
    AUDIT_KMS_DECRYPT_KEY_IDS: 'bad-json'
  }), failure('AUDIT_KMS_CONFIGURATION'));
  assert.throws(() => new AwsKmsKeyProvider({
    keyId: ARN,
    endpoint: 'invalid-url',
    nodeEnv: 'test'
  }), failure('AUDIT_KMS_CONFIGURATION'));
  assert.throws(() => new EnvironmentKeyProvider({
    keys: {
      a: Buffer.alloc(31)
    },
    activeKeyId: 'a',
    nodeEnv: 'test'
  }), failure('AUDIT_KEY_CONFIGURATION'));
  const closed = new EnvironmentKeyProvider({
    keys: {
      a: crypto.randomBytes(32)
    },
    activeKeyId: 'a',
    legacyMasterKeyId: 'a',
    nodeEnv: 'test'
  });
  closed.close();
  await assert.rejects(closed.generate(CONTEXT));
  await assert.rejects(closed.unwrap({
    v: 2
  }, CONTEXT), failure('AUDIT_KEY_ENVELOPE_INVALID'));
  await assert.rejects(closed.unwrap({
    v: 1,
    provider: 'environment',
    masterKeyId: 'a'
  }, CONTEXT), failure('AUDIT_MASTER_KEY_UNAVAILABLE'));
  await assert.rejects(closed.unwrapLegacy(Buffer.from('invalid-legacy-format')), failure('AUDIT_LEGACY_KEY_FORMAT'));
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => jsonBytes(cycle), failure('AUDIT_PAYLOAD_INVALID'));
  assert.throws(() => jsonBytes(undefined), failure('AUDIT_PAYLOAD_INVALID'));
  assert.throws(() => jsonBytes('x'.repeat(1048576)), failure('AUDIT_PAYLOAD_INVALID'));
});
