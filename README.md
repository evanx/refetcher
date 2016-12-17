# fetch-redis

Pop an HTTP URL from a Redis queue, HTTP fetch and set the response in Redis.

Development config
```javascript
namespace: 'fetch',
processExpire: 60,
messageExpire: 60,
queueLimit: 1000,
fetchTimeout: 6000,
loggerLevel: 'debug'
```
where all Redis keys will be prefixed with `fetch`

Queues:
```javascript
const queue = ['req', 'res', 'busy', 'failed', 'errored'].reduce((a, v) => {
    a[v] = `${config.namespace}:${v}:q`;
    return a;
}, {});
```

Test data
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
const id = await client.brpoplpushAsync(queue.req, queue.busy, 4);
```

The `url` is retrieved from the hashes for this `id` and fetched.
```javascript
const options = {timeout: config.fetchTimeout};
const res = await fetch(hashes.url, options);
```

If `200` response, then the response text is set in Redis, and the `id` pushed to `:res:q` i.e. for notication that the response is ready for that `id`
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

TODO
- store HTTP headers in hashes
- retry errors
