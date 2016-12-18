module.exports = {
    namespace: 'fetch',
    processExpire: 60,
    popTimeout: 2,
    queueLimit: 9000,
    fetchTimeout: 6000,
    messageExpire: 60,
    retryLimit: 3,
    perMinuteLimit: 60,
    concurrentLimit: 16,
    rateDelayLimit: 2000,
    concurrentDelay: 2000,
    loggerLevel: 'info'
};
