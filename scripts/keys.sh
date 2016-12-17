
  for key in `redis-cli keys 'fetch:*'`
  do
    echo $key ttl:`redis-cli ttl $key`
  done

  for key in `redis-cli keys 'fetch:*:h'`
  do
    echo
    echo $key `redis-cli hkeys $key`
    redis-cli hgetall $key
  done

  for key in `redis-cli keys 'fetch:*:q'`
  do
    echo
    echo $key llen:`redis-cli llen $key`
    redis-cli lrange $key 0 10
  done

