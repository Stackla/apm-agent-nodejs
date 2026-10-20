/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Reproduce https://github.com/elastic/apm-agent-nodejs/issues/4972.
// Node.js 24's Lambda runtime invokes async handlers with (event, context),
// without the callback supplied by older runtimes. Do not use lambda-local
// here: it supplies that callback and therefore hides this regression.
// This tests the invocation contract locally; it does not need AWS or Docker.

const tape = require('tape');

// The transport detects Lambda when its module is loaded.
process.env.AWS_LAMBDA_FUNCTION_NAME = 'nodejs24-runtime-test';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_LAMBDA_LOG_STREAM_NAME = 'test-log-stream';

const apm = require('../..');
const { MockAPMServer } = require('../_mock_apm_server');

tape.test('Lambda runtime invocation contract', function (suite) {
  const server = new MockAPMServer({ mockLambdaExtension: true });

  suite.test('setup', function (t) {
    server.start(function (serverUrl) {
      apm.start({
        serverUrl,
        logLevel: 'off',
        captureExceptions: false,
        centralConfig: false,
        cloudProvider: 'none',
        metricsInterval: '0s',
      });
      t.end();
    });
  });

  // Run the two-argument case first so an older runtime invocation cannot
  // initialize Lambda metadata or leave a transaction that masks the failure.
  suite.test('nodejs24.x: cold invocation', async function (t) {
    const runtime = 'nodejs24.x';
    process.env.AWS_EXECUTION_ENV = `AWS_Lambda_${runtime}`;
    server.clear();

    const context = {
      functionName: 'nodejs24-runtime-test',
      functionVersion: '$LATEST',
      invokedFunctionArn:
        'arn:aws:lambda:us-east-1:123456789012:function:nodejs24-runtime-test',
      memoryLimitInMB: '128',
      awsRequestId: `request-${runtime}`,
      logGroupName: '/aws/lambda/nodejs24-runtime-test',
      logStreamName: 'test-log-stream',
      getRemainingTimeInMillis: () => 3000,
    };
    let transaction;
    const handler = apm.lambda(async function (event) {
      transaction = apm.currentTransaction;
      return `Hello, ${event.name}`;
    });

    const event = { name: 'Lambda' };
    const result = await handler(event, context);

    t.equal(result, 'Hello, Lambda', 'async handler returns its result');
    t.ok(transaction, 'handler runs inside an APM transaction');

    // Registration is awaited before calling the user handler, so requests
    // can be checked immediately without a timer or a forced agent flush.
    const registration = server.requests.find(
      (req) => req.method === 'POST' && req.url === '/register/transaction',
    );
    t.ok(registration, 'transaction is registered with the Lambda extension');
    t.ok(
      registration && registration.body.includes('{"metadata":'),
      'Lambda extension receives metadata with the registration',
    );
    t.equal(
      handler.length,
      2,
      'wrapper exposes a signature accepted by the Node.js 24 runtime',
    );
    t.ok(transaction && transaction.ended, 'transaction ends before return');
    const completed = server.events.find((e) => e.transaction);
    t.equal(
      completed && completed.transaction.outcome,
      'success',
      'successful transaction is sent before return',
    );
    t.ok(
      server.requests.some(
        (req) => req.url === '/intake/v2/events?flushed=true',
      ),
      'agent flushes before returning to the runtime',
    );
    t.end();
  });

  const handlerError = new Error('nodejs24 handler failed');
  const cases = [
    {
      name: 'warm async invocation',
      handler: async () => {
        await Promise.resolve();
        return 'async result';
      },
      result: 'async result',
      outcome: 'success',
    },
    {
      name: 'synchronous result',
      handler: () => 'sync result',
      result: 'sync result',
      outcome: 'success',
    },
    {
      name: 'synchronous throw',
      handler: () => {
        throw handlerError;
      },
      error: handlerError,
      outcome: 'failure',
    },
    {
      name: 'async rejection',
      handler: async () => {
        await Promise.resolve();
        throw handlerError;
      },
      error: handlerError,
      outcome: 'failure',
    },
  ];
  for (const c of cases) {
    suite.test(`nodejs24.x: ${c.name}`, async function (t) {
      server.clear();
      const context = {
        functionName: 'nodejs24-runtime-test',
        functionVersion: '$LATEST',
        invokedFunctionArn:
          'arn:aws:lambda:us-east-1:123456789012:function:nodejs24-runtime-test',
        awsRequestId: c.name,
        getRemainingTimeInMillis: () => 3000,
      };
      let transaction;
      let transactionAfterAwait;
      let handlerArgs;
      let handlerThis;
      const receiver = {};
      const event = { name: 'Lambda' };
      const handler = apm.lambda(function () {
        transaction = apm.currentTransaction;
        handlerArgs = Array.from(arguments);
        handlerThis = this;
        const result = c.handler();
        if (result instanceof Promise) {
          return result.then((value) => {
            transactionAfterAwait = apm.currentTransaction;
            return value;
          });
        }
        return result;
      });

      let result;
      let error;
      try {
        result = await handler.call(receiver, event, context);
      } catch (err) {
        error = err;
      }
      t.equal(result, c.result, 'preserves the handler result');
      t.equal(error, c.error, 'preserves the original handler error');
      t.equal(handlerThis, receiver, 'preserves handler receiver');
      t.deepEqual(
        handlerArgs,
        [event, context],
        'passes exactly two arguments',
      );
      t.ok(transaction, 'handler has an APM transaction');
      if (c.name === 'warm async invocation') {
        t.equal(
          transactionAfterAwait,
          transaction,
          'transaction propagates across await',
        );
      }
      t.ok(transaction && transaction.ended, 'transaction ends before return');

      const completed = server.events.find((e) => e.transaction);
      const capturedError = server.events.find((e) => e.error);
      t.equal(
        completed && completed.transaction.outcome,
        c.outcome,
        'transaction outcome is sent before return',
      );
      if (c.error) {
        t.equal(
          capturedError && capturedError.error.exception.message,
          'nodejs24 handler failed',
          'handler error is sent before rejection',
        );
        t.equal(
          capturedError && capturedError.error.transaction_id,
          transaction && transaction.id,
          'captured error belongs to the invocation transaction',
        );
      }
      t.ok(
        server.requests.some(
          (req) => req.url === '/intake/v2/events?flushed=true',
        ),
        'agent flushes before completing the invocation',
      );
      t.end();
    });
  }

  suite.test('nodejs22.x: legacy callback invocation', function (t) {
    server.clear();
    const context = {
      functionName: 'nodejs24-runtime-test',
      functionVersion: '$LATEST',
      invokedFunctionArn:
        'arn:aws:lambda:us-east-1:123456789012:function:nodejs24-runtime-test',
      awsRequestId: 'legacy-request',
      getRemainingTimeInMillis: () => 3000,
      succeed() {},
      fail() {},
      done() {},
    };
    let transaction;
    const handler = apm.lambda((_event, _context, callback) => {
      transaction = apm.currentTransaction;
      callback(null, 'legacy result');
    });
    handler({}, context, (err, result) => {
      t.error(err, 'legacy callback succeeds');
      t.equal(result, 'legacy result', 'preserves legacy callback result');
      t.ok(transaction && transaction.ended, 'legacy transaction ends');
      const completed = server.events.find((e) => e.transaction);
      t.equal(
        completed && completed.transaction.outcome,
        'success',
        'legacy transaction is flushed before callback',
      );
      t.end();
    });
  });

  suite.test('teardown', function (t) {
    apm.destroy();
    server.close();
    t.end();
  });
  suite.end();
});
