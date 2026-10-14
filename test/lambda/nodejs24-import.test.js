/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// The Node.js 24 Lambda runtime dynamically imports even CommonJS handlers.
// This bypasses Module.prototype.require, so a require hook alone cannot wrap
// the handler. Exercise that loading path, including a later require of the
// same module, to catch both missing and duplicate instrumentation.
const path = require('path');
const { pathToFileURL } = require('url');
const semver = require('semver');
const tape = require('tape');
const Module = require('module');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'nodejs24-import-test';
process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs24.x';
process.env.AWS_REGION = 'us-east-1';
process.env.LAMBDA_TASK_ROOT = path.join(__dirname, 'fixtures');
process.env._HANDLER = 'nodejs24-import.handler';

const apm = require('../..');
const { MockAPMServer } = require('../_mock_apm_server');

tape.test(
  'Node.js 24 Lambda handler imports',
  { skip: semver.lt(process.version, '24.0.0') },
  function (suite) {
    const server = new MockAPMServer({ mockLambdaExtension: true });
    const originalCompile = Module.prototype._compile;

    suite.test('setup', function (t) {
      server.start(function (serverUrl) {
        apm.start({ serverUrl, logLevel: 'off', captureExceptions: false });
        t.end();
      });
    });

    for (const loadMethod of ['import', 'require']) {
      suite.test(loadMethod, async function (t) {
        server.clear();
        const file = path.join(__dirname, 'fixtures', 'nodejs24-import.js');
        const mod =
          loadMethod === 'import'
            ? await import(pathToFileURL(file).href)
            : require(file);
        const result = await mod.handler(
          {},
          {
            functionName: 'nodejs24-import-test',
            functionVersion: '$LATEST',
            awsRequestId: `request-${loadMethod}`,
            invokedFunctionArn:
              'arn:aws:lambda:us-east-1:123456789012:function:nodejs24-import-test',
            getRemainingTimeInMillis: () => 3000,
          },
        );
        t.ok(result.transactionId, 'handler runs inside a transaction');
        const transactions = server.events.filter((e) => e.transaction);
        t.equal(transactions.length, 1, 'exactly one transaction is sent');
        t.equal(
          transactions[0] && transactions[0].transaction.id,
          result.transactionId,
          'sent transaction is the one seen inside the handler',
        );
        t.equal(
          server.requests.filter((req) => req.url === '/register/transaction')
            .length,
          1,
          'exactly one transaction is registered',
        );
        t.end();
      });
    }

    suite.test('teardown', async function (t) {
      await apm.destroy();
      server.close();
      t.equal(
        Module.prototype._compile,
        originalCompile,
        'agent restores the CommonJS compile hook',
      );
      t.end();
    });
    suite.end();
  },
);
