# refetcher

A microservice for Redis-based streaming of HTTP requests and responses
for simplification and scaling of applicable services
that consume HTTP responses for async processing.

Since the state of HTTP requests and responses is stored in Redis,
multiple response handlers can be deployed e.g. for improved reliability and rolling updates.

Some external service can request a fetch via Redis as follows:
- generate a new unique request `id` e.g. `123` via `INCR fetch:id:seq`
- set hashes for that request especially `url` e.g. `HSET fetch:123:h url ${url}`
- push the `id` to the request queue e.g. `LPUSH fetch:req:q 123`

This service performs the following operations:
- pops the next request `id` from its Redis input queue e.g. `123` from `fetch:req:q`
- retrieve the `url` for that request from Redis hashes e.g. `fetch:123:h`
- HTTP fetch that URL using the `node-fetch` package
- set the response text in Redis e.g. `fetch:123:text` as per `res.text()`
- set the response headers in Redis e.g. `fetch:123:headers:h` hashes
- notify subscribers via Redis pubsub e.g. publish `123` to channel `fetch:res`
- handle failures, errors and retries e.g. via `fetch:retry:q`
- pause processing when request rate and concurrency limits are exceeded

Typically sync services would subscribe to the channel `fetch:res` whereas async services might pull responses from the `:res:q` output queue.


## Configuration

```javascript
```
where all Redis keys will be prefixed with `fetch`

Incidently we don't necessarily actually rate limit the URL fetching, just slow down the process as follows:
```javascript
if (Date.now() > counters.perMinute.timestamp + 60000) {
    counters.perMinute = new TimestampedCounter();
} else {
    counters.perMinute.count++;
}
if (counters.perMinute.count > config.perMinuteLimit) {
    await delay(config.rateDelayLimit);
}
```
where we pause this service for a configured `delayLimit` e.g. 2 seconds, before the next fetch operation.

## Queues

```javascript
const queueKeys = reduceKeys(
    ['req', 'res', 'busy', 'failed', 'errored', 'retry'],
    key => `${config.namespace}:${key}:q`
);
```
where queue keys are suffixed with `:q`

This service will `brpoplush` the next `id` as follows.
```javascript
let id = await client.brpoplpushAsync(queueKeys.req, queueKeys.busy, config.popTimeout);
```
where in-flight requests are pushed to the `busy` queue.

Note that the onus is on drivers of this service to ensure a unique ID for the request. Naturally Redis `INCR` is recommended on this Redis instance, e.g. on key `fetch:id:seq` to provide a unique sequence number.

If no new incoming requests, we might retry an previous failed request from the retry queue.
```javascript
if (!id) {
    if (counters.concurrent.count < config.concurrentLimit) {
        id = await client.rpoplpushAsync(queueKeys.retry, queueKeys.busy);
    }
}
```
where we first check that we are not at the limit of our concurrent requests, especially for retries.

Clear we give retries a lesser priority than new requests, and ensure they are somewhat delayed i.e. to retry "later."

After popping a request `id`, the service will retrieve the `url` from the hashes for this `id`
```javascript
const hashesKey = [config.namespace, id, 'h'].join(':');
const hashes = await client.hgetallAsync(hashesKey);
if (!hashes) {
    logger.info('hashes expired', hashesKey);
} else {
    logger.debug('url', hashes.url, hashesKey, config.messageExpire);
    client.expire(hashesKey, config.messageExpire);
    handle(id, hashesKey, hashes);
}
```

Note that it is possible that the hashes of a request from `retry:q` will have expired, or because of delays when the load exceeds configured limits. Therefore persistent retries may require intervention by your application.

## Handler

The `url` as retrieved from the hashes for this `id` is fetched i.e. an HTTP request is performed via the network.
```javascript
const res = await fetch(hashes.url, {timeout: config.fetchTimeout});
```
where we use the `node-fetch` package for the HTTP request. Note that redirects should followed by default.


## Reply

If an OK `200` HTTP response is received, then the response text is set in Redis, and the `id` pushed to `:res:q` i.e. to notify a reactive consumer that the response is ready for that `id`
```javascript
if (res.status === 200) {
    const text = await res.text();
    logger.debug('text', text.length, hashesKey);
    await multiExecAsync(client, multi => {
        multi.hset(hashesKey, 'status', res.status);
        multi.setex(`${config.namespace}:${id}:text`, config.messageExpire, text);
        Object.keys(res.headers._headers).forEach(key => {
            multi.hset(`${config.namespace}:${id}:headers:h`, key, res.headers.get(key).toString());
        });
        multi.expire(`${config.namespace}:${id}:headers:h`, config.messageExpire);
        multi.lpush(queueKeys.res, id);
        multi.ltrim(queueKeys.res, config.queueLimit);
        multi.lrem(queueKeys.busy, 1, id);
        multi.publish(`${config.namespace}:res`, id);
    });
    ...
}
```

## Error handling

Otherwise for a error status i.e. not `200` e.g. `500` or `404` or what you you, we increment a `retry` count and push the `id` to the `failed` queue.
```javascript
multi.hincrby(hashesKey, 'retry', 1);
multi.hset(hashesKey, 'limit', config.retryLimit);
multi.hset(hashesKey, 'status', res.status);
multi.lpush(queueKeys.failed, id);
multi.ltrim(queueKeys.failed, 0, config.queueLimit);
multi.lrem(queueKeys.busy, 1, id);
```
If the `retry` count is within the `limit` then it will be retried later via the `:retry:q` queue.
```javascript
if (retry < config.retryLimit) {
    await multiExecAsync(client, multi => {
        multi.lpush(queueKeys.retry, id);
        multi.ltrim(queueKeys.retry, 0, config.queueLimit);
    });
}
```

Note that if a network error occurs e.g. DNS lookup failure or request timeout, the id will be pushed to `:error:q` rather than `:fail:q`

As in the case of the `status` code, the `id` will be pushed to `:retry:q`
