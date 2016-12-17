
  redis-cli hset fetch:1:hashes url 'http://www.tesco.com/store-locator/uk/asp/towns/?l=A'
  redis-cli lpush fetch:req 1

