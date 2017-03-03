
const assert = require('assert');
const fetch = require('node-fetch');
const lodash = require('lodash');
const reduceKeys = require('reduce-keys');

const counters = {
    concurrent: 0,
    perMinute: {
        count: 0,
        timestamp: Date.now()
    }
};

const queueKeys = reduceKeys(
    ['req', 'res', 'busy', 'failed', 'errored', 'retry'],
    key => `${config.namespace}:${key}:q`
);

module.exports = async () => {
    while (true) {
        let id = await client.brpoplpushAsync(queueKeys.req, queueKeys.busy, config.popTimeout);
        if (id === 'exit') {
            await multiExecAsync(client, multi => {
                multi.lrem(queueKeys.busy, 1, id);
            });
            break;
        }
        if (id === undefined) {
            if (counters.concurrent < config.concurrentLimit) {
                id = await client.rpoplpushAsync(queueKeys.retry, queueKeys.busy);
                if (id) {
                    logger.debug('retry', id);
                }
            }
        }
        if (!id) {
            logger.some('queue empty', queueKeys.req);
            const [llen, lrange] = await multiExecAsync(client, multi => {
                multi.llen(queueKeys.busy);
                multi.lrange(queueKeys.busy, 0, 5);
            });
            if (llen) {
                logger.some('busy', lrange);
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
                if (config.concurrentLimit > 0) {
                    handle(id, hashesKey, hashes);
                } else {
                    logger.debug('await');
                    await handle(id, hashesKey, hashes);
                    logger.debug('handled', counters.concurrent);
                }
            }
            if (counters.concurrent > config.concurrentLimit) {
                logger.info('concurrent delay', config.concurrentDelay, counters.concurrent);
                await Promise.delay(config.concurrentDelay);
            }
            if (Date.now() > counters.perMinute.timestamp + 60000) {
                counters.perMinute.count = 0;
                counters.perMinute.timestamp = Date.now();
            } else {
                counters.perMinute.count++;
            }
            if (counters.perMinute.count > config.perMinuteLimit) {
                logger.info('rate delay', config.rateDelayLimit, config.perMinuteLimit);
                await Promise.delay(config.rateDelayLimit);
            }
        }
    }
    if (counters.concurrent > 0) {
        logger.warn('main exit', counters.concurrent);
        await Promise.delay(1000);
    }
    if (counters.concurrent > 0) {
        await Promise.delay(1000);
    }
    if (counters.concurrent > 0) {
        throw new DataError('Forced exit', {counters});
    }
}

async function handle(id, hashesKey, hashes) {
    counters.concurrent++;
    logger.debug('handle', id, counters.concurrent, counters.perMinute.count);
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
                multi.lpush(queueKeys.res, id);
                multi.ltrim(queueKeys.res, 0, config.queueLimit);
                multi.lrem(queueKeys.busy, 1, id);
                multi.publish(`${config.namespace}:res`, id);
            });
        } else {
            const [retry] = await multiExecAsync(client, multi => {
                multi.hincrby(hashesKey, 'retry', 1);
                multi.hset(hashesKey, 'limit', config.retryLimit);
                multi.hset(hashesKey, 'status', res.status);
                multi.lpush(queueKeys.failed, id);
                multi.ltrim(queueKeys.failed, 0, config.queueLimit);
                multi.lrem(queueKeys.busy, 1, id);
                multi.publish(`${config.namespace}:res`, id);
            });
            logger.info('status', res.status, config.retryLimit, {id, hashes, retry});
            if (retry < config.retryLimit) {
                const [llen] = await multiExecAsync(client, multi => {
                    multi.lpush(queueKeys.retry, id);
                    multi.ltrim(queueKeys.retry, 0, config.queueLimit);
                });
                logger.debug('retry llen', llen);
            }
        }
    } catch (err) {
        const [retry] = await multiExecAsync(client, multi => {
            multi.hincrby(hashesKey, 'retry', 1);
            multi.hset(hashesKey, 'limit', config.retryLimit);
            multi.hset(hashesKey, 'error', err.message);
            multi.lpush(queueKeys.errored, id);
            multi.ltrim(queueKeys.errored, 0, config.queueLimit);
            multi.lrem(queueKeys.busy, 1, id);
        });
        logger.warn('error', err.message, config.retryLimit, {id, hashes, retry});
        if (retry < config.retryLimit) {
            const [llen, lrange] = await multiExecAsync(client, multi => {
                multi.lpush(queueKeys.retry, id);
                multi.lrange(queueKeys.retry, 0, 5);
                multi.ltrim(queueKeys.retry, 0, config.queueLimit);
            });
            logger.debug('retry llen', llen, lrange);
        }
    } finally {
        counters.concurrent--;
        if (counters.concurrent === 0) {
        }
    }
}
