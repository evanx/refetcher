
  for key in `redis-cli keys 'fetch:*'`
  do
    echo $key `redis-cli del $key`
  done
