let multiExecAsync = (() => {
    var _ref = _asyncToGenerator(function* (client, multiFunction) {
        const multi = client.multi();
        multiFunction(multi);
        return Promise.promisify(multi.exec).call(multi);
    });

    return function multiExecAsync(_x, _x2) {
        return _ref.apply(this, arguments);
    };
})();

let start = (() => {
    var _ref2 = _asyncToGenerator(function* () {
        logger.info('config', { config });
        if (process.env.NODE_ENV === 'test') {
            return test();
        }
        return end();
    });

    return function start() {
        return _ref2.apply(this, arguments);
    };
})();

let test = (() => {
    var _ref3 = _asyncToGenerator(function* () {});

    return function test() {
        return _ref3.apply(this, arguments);
    };
})();

let end = (() => {
    var _ref4 = _asyncToGenerator(function* () {
        client.quit();
    });

    return function end() {
        return _ref4.apply(this, arguments);
    };
})();

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const assert = require('assert');
const fetch = require('node-fetch');
const lodash = require('lodash');
const Promise = require('bluebird');

const config = require(process.env.configFile || '../config/' + (process.env.NODE_ENV || 'production'));

const redis = require('redis');
const client = Promise.promisifyAll(redis.createClient());

const logger = require('winston');
logger.level = config.loggerLevel || 'info';

start().then(() => {
    logger.info('started');
}).catch(err => {
    logger.error(err);
    end();
}).finally(() => {
    logger.info('finally');
});
