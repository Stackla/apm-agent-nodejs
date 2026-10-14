/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const apm = require('../../..');

exports.handler = async function () {
  await Promise.resolve();
  return { transactionId: apm.currentTransaction && apm.currentTransaction.id };
};
