let multiExecAsync = (() => {
    var _ref = _asyncToGenerator(function* (client, multiFunction) {
        const multi = client.multi();
        multiFunction(multi);
        return Promise.promisify(multi.exec).call(multi);
    });

    return function multiExecAsync(_x, _x2) {
        return _ref.apply(this, arguments);
    };
})();

let delay = (() => {
    var _ref2 = _asyncToGenerator(function* (duration) {
        logger.debug('delay', duration);
        return new Promise(function (resolve) {
            return setTimeout(resolve, duration);
        });
    });

    return function delay(_x3) {
        return _ref2.apply(this, arguments);
    };
})();

let start = (() => {
    var _ref3 = _asyncToGenerator(function* () {
        state.started = Math.floor(Date.now() / 1000);
        state.pid = process.pid;
        state.instanceId = yield client.incrAsync(`${ config.namespace }:instance:seq`);
        logger.info('start', { config, state, queue });
        const instanceKey = `${ config.namespace }:instance:${ state.instanceId }:h`;
        yield multiExecAsync(client, function (multi) {
            ['started', 'pid'].forEach(function (property) {
                multi.hset(instanceKey, property, state[property]);
            });
            multi.expire(instanceKey, config.processExpire);
        });
        if (process.env.NODE_ENV === 'development') {
            yield startDevelopment();
        } else if (process.env.NODE_ENV === 'test') {
            return startTest();
        } else {}
        while (true) {
            let id = yield client.brpoplpushAsync(queue.req, queue.busy, config.popTimeout);
            if (!id) {
                id = yield client.rpoplpushAsync(queue.retry, queue.busy);
            }
            if (!id) {
                logger.debug('queue empty', queue.req);
                const [llen, lrange] = yield multiExecAsync(client, function (multi) {
                    multi.llen(queue.busy);
                    multi.lrange(queue.busy, 0, 5);
                });
                if (llen) {
                    logger.debug('busy', lrange);
                }
            }
            if (id) {
                const hashesKey = [config.namespace, id, 'h'].join(':');
                const hashes = yield client.hgetallAsync(hashesKey);
                if (!hashes) {
                    logger.info('hashes expired', hashesKey);
                } else {
                    logger.debug('url', hashes.url, hashesKey, config.messageExpire);
                    client.expire(hashesKey, config.messageExpire);
                    handle(id, hashesKey, hashes);
                }
                if (Date.now() > counters.perMinute.timestamp + 60000) {
                    counters.perMinute = new TimestampedCounter();
                } else {
                    counters.perMinute.count++;
                }
                while (counters.concurrent.count > config.concurrentLimit) {
                    yield delay(config.concurrentDelayLimit);
                }
                if (counters.perMinute.count > config.perMinuteLimit) {
                    yield delay(config.rateDelayLimit);
                }
            }
        }
        return end();
    });

    return function start() {
        return _ref3.apply(this, arguments);
    };
})();

let handle = (() => {
    var _ref4 = _asyncToGenerator(function* (id, hashesKey, hashes) {
        counters.concurrent.count++;
        logger.debug('handle', id, counters.concurrent.count, counters.perMinute.count);
        try {
            if (!/[0-9]$/.test(id)) {
                throw new Error(`invalid id ${ id }`);
            }
            if (!hashes.url || hashes.url.endsWith('undefined')) {
                throw new Error(`invalid id ${ id } url ${ hashes.url }`);
            }
            const options = { timeout: config.fetchTimeout };
            const res = yield fetch(hashes.url, options);
            if (res.status === 200) {
                const text = yield res.text();
                logger.debug('text', text.length, hashesKey);
                yield multiExecAsync(client, function (multi) {
                    Object.keys(res.headers._headers).forEach(function (key) {
                        multi.hset(`${ config.namespace }:${ id }:headers:h`, key, res.headers.get(key).toString());
                    });
                    multi.expire(`${ config.namespace }:${ id }:headers:h`, config.messageExpire);
                    multi.hset(hashesKey, 'status', res.status);
                    multi.hset(hashesKey, 'content-type', res.headers.get('content-type'));
                    multi.setex(`${ config.namespace }:${ id }:text`, config.messageExpire, text);
                    multi.lpush(queue.res, id);
                    multi.ltrim(queue.res, 0, config.queueLimit);
                    multi.lrem(queue.busy, 1, id);
                    multi.publish(`${ config.namespace }:res`, id);
                });
            } else {
                const [retry] = yield multiExecAsync(client, function (multi) {
                    multi.hincrby(hashesKey, 'retry', 1);
                    multi.hset(hashesKey, 'limit', config.retryLimit);
                    multi.hset(hashesKey, 'status', res.status);
                    multi.lpush(queue.failed, id);
                    multi.ltrim(queue.failed, 0, config.queueLimit);
                    multi.lrem(queue.busy, 1, id);
                    multi.publish(`${ config.namespace }:res`, id);
                });
                logger.info('status', res.status, config.retryLimit, { id, hashes, retry });
                if (retry < config.retryLimit) {
                    const [llen] = yield multiExecAsync(client, function (multi) {
                        multi.lpush(queue.retry, id);
                        multi.ltrim(queue.retry, 0, config.queueLimit);
                    });
                    logger.debug('retry llen', llen);
                }
            }
        } catch (err) {
            const [retry] = yield multiExecAsync(client, function (multi) {
                multi.hincrby(hashesKey, 'retry', 1);
                multi.hset(hashesKey, 'limit', config.retryLimit);
                multi.hset(hashesKey, 'error', err.message);
                multi.lpush(queue.errored, id);
                multi.ltrim(queue.errored, 0, config.queueLimit);
                multi.lrem(queue.busy, 1, id);
            });
            logger.warn('error', err.message, config.retryLimit, { id, hashes, retry });
            if (retry < config.retryLimit) {
                const [llen, lrange] = yield multiExecAsync(client, function (multi) {
                    multi.lpush(queue.retry, id);
                    multi.lrange(queue.retry, 0, 5);
                    multi.ltrim(queue.retry, 0, config.queueLimit);
                });
                logger.debug('retry llen', llen, lrange);
            }
        } finally {
            counters.concurrent.count--;
        }
    });

    return function handle(_x4, _x5, _x6) {
        return _ref4.apply(this, arguments);
    };
})();

let startTest = (() => {
    var _ref5 = _asyncToGenerator(function* () {});

    return function startTest() {
        return _ref5.apply(this, arguments);
    };
})();

let startDevelopment = (() => {
    var _ref6 = _asyncToGenerator(function* () {
        logger.info('startDevelopment', config.namespace, queue.req);
        yield Promise.all(Object.keys(testData).map((() => {
            var _ref7 = _asyncToGenerator(function* (key, index) {
                const id = index + 101;
                const results = yield multiExecAsync(client, function (multi) {
                    testData[key](multi, { id });
                });
                logger.info('results', key, id, results.join(' '));
            });

            return function (_x7, _x8) {
                return _ref7.apply(this, arguments);
            };
        })()));
        logger.info('llen', queue.req, (yield client.llenAsync(queue.req)));
    });

    return function startDevelopment() {
        return _ref6.apply(this, arguments);
    };
})();

let end = (() => {
    var _ref8 = _asyncToGenerator(function* () {
        client.quit();
    });

    return function end() {
        return _ref8.apply(this, arguments);
    };
})();

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

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

const queue = ['req', 'res', 'busy', 'failed', 'errored', 'retry'].reduce((a, v) => {
    a[v] = `${ config.namespace }:${ v }:q`;
    return a;
}, {});

const testData = {
    ok: (multi, ctx) => {
        multi.hset(`${ config.namespace }:${ ctx.id }:h`, 'url', 'http://httpstat.us/200');
        multi.lpush(queue.req, ctx.id);
    },
    invalidId: (multi, ctx) => {
        multi.hset(`${ config.namespace }:undefined:h`, 'url', 'http://httpstat.us/200');
        multi.lpush(queue.req, 'undefined');
    },
    missingUrl: (multi, ctx) => {
        multi.hset(`${ config.namespace }:${ ctx.id }:h`, 'undefined', 'http://httpstat.us/200');
        multi.lpush(queue.req, ctx.id);
    },
    timeout: (multi, ctx) => {
        multi.hset(`${ config.namespace }:${ ctx.id }:h`, 'url', 'https://com.invalid');
        multi.lpush(queue.req, ctx.id);
    },
    errorUrl: (multi, ctx) => {
        multi.hset(`${ config.namespace }:${ ctx.id }:h`, 'url', 'http://httpstat.us/500');
        multi.lpush(queue.req, ctx.id);
    },
    invalidUrl: (multi, ctx) => {
        multi.hset(`${ config.namespace }:${ ctx.id }:h`, 'url', 'http://undefined');
        multi.lpush(queue.req, ctx.id);
    }
};

start().then(() => {
    logger.info('started');
}).catch(err => {
    logger.error(err);
    end();
}).finally(() => {});
