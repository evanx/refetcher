set -u -e -x
  redis-cli keys 'fetch:*' | xargs -r -n 1 redis-cli del
  redis-cli hset fetch:1:h url 'http://www.argos.co.uk/stores/Aberdare'
  redis-cli lpush fetch:req:q 1
  redis-cli lpush fetch:req:q exit
  npm start
  redis-cli keys 'fetch:*'
  redis-cli hgetall 'fetch:1:h'
  redis-cli get fetch:1:text | wc
  echo 'OK'
