const serverless = require('serverless-http');

let handlerPromise;

exports.handler = async (event, context) => {
  if (!handlerPromise) {
    handlerPromise = import('../../server.js').then(mod => serverless(mod.app));
  }
  const handler = await handlerPromise;
  return handler(event, context);
};
