
require('redis-app')(
    require('../package'),
    require('./spec')
).then(
    require('./main')
).catch(err => {
    global.application.catch(err);
})
