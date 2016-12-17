
  for key in `redis-cli keys 'evanx:fetch:*:hashes'`
  do
    echo $key
    redis-cli hgetall $key
    redis-cli del $key
    echo
  done
