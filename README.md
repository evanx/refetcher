# fetch-redis

A microservice for Redis queuing of HTTP requests and responses,
to simplify services that require async HTTP processing.

This service performs the following operations:
- pops an HTTP URL from a Redis queue
- HTTP fetch that URL
- set the response in Redis
- handle failures, errors and retries

Having pushed URLs into a Redis queue for async fetching, consumer services can reactively pop ready responses from Redis. Such application services are thereby simplified.

Since the state of HTTP requests and responses is stored in Redis, consumers are "stateless."
Therefore multiple consumers can be deployed e.g. for improved reliability and rolling updates.

## Configuration

`config/development.js`
```javascript
namespace: 'fetch',
processExpire: 60,
popTimeout: 1,
messageExpire: 60,
queueLimit: 1000,
fetchTimeout: 6000,
retryLimit: 2,
loggerLevel: 'debug'
```
where all Redis keys will be prefixed with `fetch`


## Queues

```javascript
const queue = ['req', 'res', 'busy', 'failed', 'errored', 'retry'].reduce((a, v) => {
    a[v] = `${config.namespace}:${v}:q`;
    return a;
}, {});
```

Note our convention that Redis keys for queues are postfixed with `:q`


## Test data

```javascript
const testData = {
    ok: (multi, ctx) => {
        multi.hset(`${config.namespace}:${ctx.id}:h`, 'url', ctx.validUrl);
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
```
where the `url` is set in hashes for a specific `id` e.g. hashes `fetch:1:h` has member `url` for request `1`

Note our convention that Redis keys for hashes are postfixed with `:h`


## Activation

A ready request `id` is pushed to the request queue by some producer, which has prepared the hashes for that request, notably the `url`

This service will `brpoplush` that `id`
```javascript
let id = await client.brpoplpushAsync(queue.req, queue.busy, config.popTimeout);
if (!id) {
    id = await client.rpoplpushAsync(queue.retry, queue.busy);
}
```
where in-flight requests are pushed to the `busy` queue.

Note that only after the `popTimeout` on the blocking pop on the request queue, we will retry an earlier request from the retry queue. Therefore retries have a lesser priority than new requests, and are somewhat delayed.

Then it will retrieve the `url` from the hashes for this request `id`
```javascript
const hashesKey = [config.namespace, id, 'h'].join(':');
const hashes = await client.hgetallAsync(hashesKey);
if (!hashes) {
    logger.error('hashes', hashesKey);
} else {
    logger.debug('url', hashes.url, hashesKey, config.messageExpire);
    client.expire(hashesKey, config.messageExpire);
    handle(id, hashesKey, hashes);
}
```

Note that the onus is on consumers of this service to ensure a unique ID for the request. Naturally Redis `INCR` is recommended on this Redis instance, e.g. on key `fetch:id:seq` to provide a unique sequence number.

## Handler

The `url` as retrieved from the hashes for this `id` is fetched i.e. an HTTP request is performed.
```javascript
const res = await fetch(hashes.url, {timeout: config.fetchTimeout});
```
where we use the `node-fetch` package for the HTTP request. Note that redirects should followed by default.


## Reply

If an OK `200` HTTP response, then the response text is set in Redis, and the `id` pushed to `:res:q` i.e. to notify a reactive consumer that the response is ready for that `id`
```javascript
if (res.status === 200) {
    const text = await res.text();
    logger.debug('text', text.length, hashesKey);
    await multiExecAsync(client, multi => {
        multi.hset(hashesKey, 'status', res.status);
        multi.setex(`${config.namespace}:${id}:text`, config.messageExpire, text);
        multi.hmset(`${config.namespace}:${id}:headers:h`, res.headers._headers);
        multi.expire(`${config.namespace}:${id}:headers:h`, config.messageExpire);
        multi.lpush(queue.res, id);
        multi.ltrim(queue.res, config.queueLimit);
        multi.lrem(queue.busy, 1, id);
        multi.publish(`${config.namespace}:res`, id);
    });
```

Note that consumers who have pushed a request ID could subscribe to the channel `fetch:res` to be notified when the response is ready. Alternatively:
- monitor the `res:q` output queue
- poll for `fetch:${id}:text`
- poll the `status` member of the hashes `:${id}:h`

## Error handling

Otherwise for a error status i.e. not `200` e.g. `500` or `404` or what you you, we increment a `retry` count and "move" the `id` to the `failed` queue.
```javascript
multi.hincrby(hashesKey, 'retry', 1);
multi.hset(hashesKey, 'limit', config.retryLimit);
multi.hset(hashesKey, 'status', res.status);
multi.lpush(queue.failed, id);
multi.ltrim(queue.failed, 0, config.queueLimit);
multi.lrem(queue.busy, 1, id);
```
If the `retry` count is within the `limit` then it will be retried later via the `:retry:q` queue.
