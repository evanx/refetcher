
  for key in `redis-cli keys 'fetch:*:h'`
  do
    echo $key `redis-cli hkeys $key`
    redis-cli hgetall $key
    echo
  done
