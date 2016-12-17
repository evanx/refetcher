# fetch-redis

A microservice for Redis queuing of HTTP requests and responses,
to simplify services that require async HTTP processing.

This service performs the following operations:
- pops an HTTP URL from a Redis queue
- HTTP fetch that URL
- set the response in Redis
- handle failures, errors and retries

Having pushed URLs for async fetching in Redis, consumer services can reactively pop ready responses from Redis.
Such application services are thereby simplified.

Since the state of HTTP requests and responses is stored in Redis, consumers are "stateless."
Therefore multiple consumers can be deployed e.g. for improved reliability and rolling updates.

## Development configuration

Development config
```javascript
namespace: 'fetch',
processExpire: 60,
popTimeout: 4000,
messageExpire: 60,
queueLimit: 1000,
fetchTimeout: 6000,
retryLimit: 2,
loggerLevel: 'debug'
```
where all Redis keys will be prefixed with `fetch`

## Implementation

Queues:
```javascript
const queue = ['req', 'res', 'busy', 'failed', 'errored', 'retry'].reduce((a, v) => {
    a[v] = `${config.namespace}:${v}:q`;
    return a;
}, {});
```

Sample test data
```javascript
multi.hset(`${config.namespace}:1:h`, 'url', url);
multi.lpush(queue.req, '1');
multi.hset(`${config.namespace}:2:h`, 'url', 'https://invalid');
multi.lpush(queue.req, '2');
multi.hset(`${config.namespace}:undefined:h`, 'url', 'undefined');
multi.lpush(queue.req, 'undefined');
```
where the `url` is set in hashes for a specific `id` e.g. `1`

The ready `id` is pushed to the request queue. This service will `brpoplush` that `id`
```javascript
let id = await client.brpoplpushAsync(queue.req, queue.busy, 8);
if (!id) {
    id = await client.rpoplpushAsync(queue.retry, queue.busy);
}
```
where in-flight requests are pushed to the `busy` queue.

The `url` is retrieved from the hashes for this `id` and fetched.
```javascript
const options = {timeout: config.fetchTimeout};
const res = await fetch(hashes.url, options);
```
where we use the `node-fetch` package for the HTTP request.

If an OK `200` HTTP response, then the response text is set in Redis, and the `id` pushed to `:res:q` i.e. for notication that the response is ready for that `id`
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

Otherwise for a non 200 status, we increment a `retry` count and move to the `failed` queue.
```javascript
multi.hincrby(hashesKey, 'retry', 1);
multi.hset(hashesKey, 'status', res.status);
multi.lpush(queue.failed, id);
multi.ltrim(queue.failed, 0, config.queueLimit);
multi.lrem(queue.busy, 1, id);
```
