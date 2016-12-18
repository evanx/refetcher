module.exports = {
    namespace: 'fetch',
    processExpire: 60,
    popTimeout: 1,
    queueLimit: 1000,
    fetchTimeout: 6000,
    messageExpire: 60,
    retryLimit: 5,
    perMinuteLimit: 60,
    concurrentLimit: 2,
    rateDelayLimit: 2000,
    concurrentDelayLimit: 2000,
    loggerLevel: 'debug'
};
