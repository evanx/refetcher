const assert = require('assert');
const fetch = require('node-fetch');
const lodash = require('lodash');
const Promise = require('bluebird');

const envName = process.env.NODE_ENV || 'production';
const config = require(process.env.configFile || '../config/' + envName);
const state = {};
const redis = require('redis');
const client = Promise.promisifyAll(redis.createClient());

const logger = require('winston');
logger.level = config.loggerLevel || 'info';

class Counter {
    constructor() {
        this.count = 0;
    }
}

class TimestampedCounter {
    constructor() {
        this.timestamp = Date.now();
        this.count = 0;
    }
}

const counters = {
    concurrent: new Counter(),
    perMinute: new TimestampedCounter()
};

async function multiExecAsync(client, multiFunction) {
    const multi = client.multi();
    multiFunction(multi);
    return Promise.promisify(multi.exec).call(multi);
}

const queue = ['req', 'res', 'busy', 'failed', 'errored', 'retry'].reduce((a, v) => {
    a[v] = `${config.namespace}:${v}:q`;
    return a;
}, {});

async delay(duration) {
    logger.info('delay');
    return new Promise(resolve => setTimeout(resolve, duration));
}

async function start() {
    state.started = Math.floor(Date.now()/1000);
    state.pid = process.pid;
    state.instanceId = await client.incrAsync(`${config.namespace}:instance:seq`);
    logger.info('start', {config, state, queue});
    const instanceKey = `${config.namespace}:instance:${state.instanceId}:h`;
    await multiExecAsync(client, multi => {
        ['started', 'pid'].forEach(property => {
            multi.hset(instanceKey, property, state[property]);
        });
        multi.expire(instanceKey, config.processExpire);
    });
    if (process.env.NODE_ENV === 'development') {
        await startDevelopment();
    } else if (process.env.NODE_ENV === 'test') {
        return startTest();
    } else {
    }
    while (true) {
        let id = await client.brpoplpushAsync(queue.req, queue.busy, config.popTimeout);
        if (!id) {
            id = await client.rpoplpushAsync(queue.retry, queue.busy);
        }
        if (!id) {
            logger.debug('queue empty', queue.req);
            const [llen, lrange] = await multiExecAsync(client, multi => {
                multi.llen(queue.busy);
                multi.lrange(queue.busy, 0, 5);
            });
            if (llen) {
                logger.debug('busy', lrange);
            }
        }
        if (id) {
            const hashesKey = [config.namespace, id, 'h'].join(':');
            const hashes = await client.hgetallAsync(hashesKey);
            if (!hashes) {
                logger.info('hashes expired', hashesKey);
            } else {
                logger.debug('url', hashes.url, hashesKey, config.messageExpire);
                client.expire(hashesKey, config.messageExpire);
                handle(id, hashesKey, hashes);
            }
            if (Date.now() > counters.perMinute.timestamp + 60) {
                counters.perMinute = new TimestampedCounter();
            } else {
                counters.perMinute.count++;
            }
            if (counters.concurrent.count > config.concurrentLimit ||
                counters.perMinute.count > config.perMinuteLimit) {
                    await delay(config.delayDuration);
            }
        }
    }
    return end();
}

async function handle(id, hashesKey, hashes) {
    counters.concurrent.count++;
    try {
        if (!/[0-9]$/.test(id)) {
            throw new Error(`invalid id ${id}`);
        }
        if (!hashes.url || hashes.url.endsWith('undefined')) {
            throw new Error(`invalid id ${id} url ${hashes.url}`);
        }
        const options = {timeout: config.fetchTimeout};
        const res = await fetch(hashes.url, options);
        if (res.status === 200) {
            const text = await res.text();
            logger.debug('text', text.length, hashesKey);
            await multiExecAsync(client, multi => {
                Object.keys(res.headers._headers).forEach(key => {
                    multi.hset(`${config.namespace}:${id}:headers:h`, key, res.headers.get(key).toString());
                });
                multi.expire(`${config.namespace}:${id}:headers:h`, config.messageExpire);
                multi.hset(hashesKey, 'status', res.status);
                multi.hset(hashesKey, 'content-type', res.headers.get('content-type'));
                multi.setex(`${config.namespace}:${id}:text`, config.messageExpire, text);
                multi.lpush(queue.res, id);
                multi.ltrim(queue.res, 0, config.queueLimit);
                multi.lrem(queue.busy, 1, id);
                multi.publish(`${config.namespace}:res`, id);
            });
        } else {
            const [retry] = await multiExecAsync(client, multi => {
                multi.hincrby(hashesKey, 'retry', 1);
                multi.hset(hashesKey, 'limit', config.retryLimit);
                multi.hset(hashesKey, 'status', res.status);
                multi.lpush(queue.failed, id);
                multi.ltrim(queue.failed, 0, config.queueLimit);
                multi.lrem(queue.busy, 1, id);
                multi.publish(`${config.namespace}:res`, id);
            });
            logger.info('status', res.status, config.retryLimit, {id, hashes, retry});
            if (retry < config.retryLimit) {
                const [llen] = await multiExecAsync(client, multi => {
                    multi.lpush(queue.retry, id);
                    multi.ltrim(queue.retry, 0, config.queueLimit);
                });
                logger.debug('retry llen', llen);
            }
        }
    } catch (err) {
        const [retry] = await multiExecAsync(client, multi => {
            multi.hincrby(hashesKey, 'retry', 1);
            multi.hset(hashesKey, 'limit', config.retryLimit);
            multi.hset(hashesKey, 'error', err.message);
            multi.lpush(queue.errored, id);
            multi.ltrim(queue.errored, 0, config.queueLimit);
            multi.lrem(queue.busy, 1, id);
        });
        logger.warn('error', err.message, config.retryLimit, {id, hashes, retry});
        if (retry < config.retryLimit) {
            const [llen, lrange] = await multiExecAsync(client, multi => {
                multi.lpush(queue.retry, id);
                multi.lrange(queue.retry, 0, 5);
                multi.ltrim(queue.retry, 0, config.queueLimit);
            });
            logger.debug('retry llen', llen, lrange);
        }
    } finally {
        counters.concurrent.count--;
    }
}

async function startTest() {
}

const testData = {
    ok: (multi, ctx) => {
        multi.hset(`${config.namespace}:${ctx.id}:h`, 'url', 'http://httpstat.us/200');
        multi.lpush(queue.req, ctx.id);
    },
    invalidId: (multi, ctx) => {
        multi.hset(`${config.namespace}:undefined:h`, 'url', 'http://httpstat.us/200');
        multi.lpush(queue.req, 'undefined');
    },
    missingUrl: (multi, ctx) => {
        multi.hset(`${config.namespace}:${ctx.id}:h`, 'undefined', 'http://httpstat.us/200');
        multi.lpush(queue.req, ctx.id);
    },
    timeout: (multi, ctx) => {
        multi.hset(`${config.namespace}:${ctx.id}:h`, 'url', 'https://com.invalid');
        multi.lpush(queue.req, ctx.id);
    },
    errorUrl: (multi, ctx) => {
        multi.hset(`${config.namespace}:${ctx.id}:h`, 'url', 'http://httpstat.us/500');
        multi.lpush(queue.req, ctx.id);
    },
    invalidUrl: (multi, ctx) => {
        multi.hset(`${config.namespace}:${ctx.id}:h`, 'url', 'http://undefined');
        multi.lpush(queue.req, ctx.id);
    }
};

async function startDevelopment() {
    logger.info('startDevelopment', config.namespace, queue.req);
    await Promise.all(Object.keys(testData).map(async (key, index) => {
        const id = index + 101;
        const results = await multiExecAsync(client, multi => {
            testData[key](multi, {id});
        });
        logger.info('results', key, id, results.join(' '));
    }));
    logger.info('llen', queue.req, await client.llenAsync(queue.req));
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
});
