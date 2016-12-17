
  for key in `redis-cli keys 'fetch:*:hashes'`
  do
    echo $key ttl:`redis-cli ttl $key`
    redis-cli hgetall $key
    echo
  done
