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
// valid test page to fetch
multi.hset(`${config.namespace}:1:h`, 'url', url);
multi.lpush(queue.req, '1');
// invalid URL that should timeout
multi.hset(`${config.namespace}:2:h`, 'url', 'https://invalid');
multi.lpush(queue.req, '2');
// invalid URL that should not even be attempted
multi.hset(`${config.namespace}:undefined:h`, 'url', 'undefined');
multi.lpush(queue.req, 'undefined');
```
where the `url` is set in hashes for a specific `id` e.g. `1`

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

Note that only after the `popTimeout` on the blocking pop on the request queue, we will retry an earlier request from the retry queue. Therefor retries have a lesser priority than new requests, and are somewhat delayed.

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
    });
```

## Error handling

Otherwise for a error status i.e. not `200` e.g. `500` or `404` or what you you, we increment a `retry` count and "move" the `id` to the `failed` queue.
```javascript
multi.hincrby(hashesKey, 'retry', 1);
multi.hset(hashesKey, 'status', res.status);
multi.lpush(queue.failed, id);
multi.ltrim(queue.failed, 0, config.queueLimit);
multi.lrem(queue.busy, 1, id);
```
