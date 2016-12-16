const assert = require('assert');
const fetch = require('node-fetch');
const lodash = require('lodash');
const Promise = require('bluebird');

const config = require(process.env.configFile || '../config/' + (process.env.NODE_ENV || 'production'));

const redis = require('redis');
const client = Promise.promisifyAll(redis.createClient());

const logger = require('winston');
logger.level = config.loggerLevel || 'info';

async function multiExecAsync(client, multiFunction) {
    const multi = client.multi();
    multiFunction(multi);
    return Promise.promisify(multi.exec).call(multi);
}

async function start() {
    logger.info('config', {config});
    if (process.env.NODE_ENV === 'test') {
      return test();
    }
    return end();
}

async function test() {
}

async function end() {
    client.quit();
}

start().then(() => {
    logger.info('started');
}).catch(err => {
    logger.error(err);
    end();
}).finally(() => {
    logger.info('finally');
});
