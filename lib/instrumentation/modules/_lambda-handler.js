/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const propwrap = require('../../propwrap');
const Module = require('module');

/**
 * Return a patch handler, `function (module, agent, options)`, that will patch
 * the Lambda handler function at the given property path.
 *
 * For example, a Lambda _HANDLER=index.handler indicates that a file "index.js"
 * has a `handler` export that is the Lambda handler function. In this case
 * `module` will be the imported "index.js" module and `propPath` will be
 * "handler".
 */
function createLambdaPatcher(propPath) {
  const wrappedHandlers = new WeakSet();
  return function lambdaHandlerPatcher(module, agent, { enabled }) {
    if (!enabled) {
      return module;
    }

    try {
      const newMod = propwrap.wrap(module, propPath, (orig) => {
        // A CommonJS handler can be seen by both the compile and require
        // hooks. Preserve the wrapper rather than nesting transactions.
        if (wrappedHandlers.has(orig)) {
          return orig;
        }
        const wrapped = agent.lambda(orig);
        wrappedHandlers.add(wrapped);
        return wrapped;
      });
      return newMod;
    } catch (wrapErr) {
      agent.logger.warn('could not wrap lambda handler: %s', wrapErr);
      return module;
    }
  };
}

// Node.js 24's Lambda runtime uses import() for CommonJS handlers too. Such
// imports bypass Module.prototype.require, but still compile the module.
// Patch the exports before Node snapshots them into the import namespace.
function hookLambdaHandlerImports(filePath, onLoad) {
  const originalCompile = Module.prototype._compile;
  let enabled = true;
  function wrappedCompile(source, filename) {
    const result = originalCompile.apply(this, arguments);
    if (enabled && filename === filePath) {
      this.exports = onLoad(this.exports);
    }
    return result;
  }
  Module.prototype._compile = wrappedCompile;
  return function unhook() {
    enabled = false;
    if (Module.prototype._compile === wrappedCompile) {
      Module.prototype._compile = originalCompile;
    }
  };
}

module.exports = {
  createLambdaPatcher,
  hookLambdaHandlerImports,
};
