module.exports = pkg => ({
    env: {
        redisHost: {
            description: 'the Redis host',
            default: 'localhost'
        },
        redisPort: {
            description: 'the Redis port',
            default: 6379
        },
        namespace: {
            description: 'the Redis key namespace',
            default: pkg.lastName
        },
    },
    config: env => ({
        inq: {
            description: 'the queue to import',
            default: `${env.namespace}:in:q`
        },
        outq: {
            description: 'the output key queue',
            default: `${env.namespace}:out:q`
        },
        busyq: {
            description: 'the pending list for brpoplpush',
            default: `${env.namespace}:busy:q`
        },
        popTimeout: {
            description: 'the timeout for brpoplpush',
            unit: 'seconds',
            default: 10,
            defaults: {
                development: 1
            }
        },
        queueLimit: {
            description: 'the queue length limit',
            default: 9000
        },
        fetchTimeout: {
            description: 'the fetch timeout',
            unit: 'ms',
            default: 6000
        },
        messageExpire: {
            description: 'the message TTL',
            unit: 's',
            default: 60,
        },
        retryLimit: {
            description: 'the retry limit',
            default: 3
        },
        perMinuteLimit: {
            description: 'the per minute limit',
            default: 60
        },
        concurrentLimit: {
            description: 'the concurrent limit',
            default: 16,
            defaults: {
                development: 0
            }
        },
        rateDelayLimit: {
            description: 'the rate delay limit',
            default: 2000
        },
        concurrentDelay: {
            description: 'the concurrent delay',
            unit: 'ms',
            default: 2000
        },
        loggerLevel: {
            description: 'the logging level',
            defaults: {
                production: 'info',
                test: 'info',
                development: 'debug'
            }
        }
    })
});
