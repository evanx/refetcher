# fetch-redis

Pop an HTTP URL from a Redis queue, HTTP fetch and set the response in Redis.

Development config
```javascript
ns: 'fetch',
instanceExpire: 60,
resExpire: 60,
queueLimit: 1000,
fetchTimeout: 6000,
loggerLevel: 'debug'
```
where all Redis keys will be prefixed with `fetch`

Queues:
```javascript
const reqQueue = `${config.namespace}:req:q`;
const resQueue = `${config.namespace}:res:q`;
const busyQueue = `${config.namespace}:busy:q`;
const failedQueue = `${config.namespace}:failed:q`;
const errorQueue = `${config.namespace}:err:q`;
```

Test data
```javascript
multi.hset(`${config.namespace}:1:h`, 'url', url);
multi.lpush(reqQueue, '1');
multi.hset(`${config.namespace}:2:h`, 'url', 'https://invalid');
multi.lpush(reqQueue, '2');
multi.hset(`${config.namespace}:undefined:h`, 'url', 'undefined');
multi.lpush(reqQueue, 'undefined');
```
where the `url` is set in hashes for a specific `id` e.g. `1`

The ready `id` is pushed to the request queue. This service will `brpoplush` that `id`
```javascript
const id = await client.brpoplpushAsync(reqQueue, busyQueue, 4);
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
        multi.setex(`${config.namespace}:${id}:text`, config.resExpire, text);
        multi.lpush(resQueue, id);
        multi.ltrim(resQueue, config.queueLimit);
        multi.lrem(busyQueue, 1, id);
    });
```

TODO
- store HTTP headers in hashes
- retry errors
