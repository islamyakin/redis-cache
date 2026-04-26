async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomJitter(minMs = 50, maxMs = 100) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
}

async function getProductSafeWithBloom(id) {
  const cacheKey = `product:${id}`
  const lockKey = `lock:product:${id}`

  // 1. Cegah cache penetration
  const mightExist = await bloomFilter.exists(id)

  if (!mightExist) {
    return {
      source: 'bloom-filter',
      data: null,
      status: 404
    }
  }

  // 2. Cek cache
  const cached = await redis.get(cacheKey)

  if (cached) {
    const parsed = JSON.parse(cached)

    return {
      source: parsed === null ? 'negative-cache' : 'cache',
      data: parsed,
      status: parsed === null ? 404 : 200
    }
  }

  // 3. Coba ambil lock
  const lockAcquired = await redis.set(lockKey, '1', {
    NX: true,
    EX: 5
  })

  if (lockAcquired) {
    try {
      const product = await fetchProduct(id)

      if (!product) {
        await redis.set(cacheKey, JSON.stringify(null), {
          EX: 60
        })

        return {
          source: 'db-not-found',
          data: null,
          status: 404
        }
      }

      await redis.set(cacheKey, JSON.stringify(product), {
        EX: 300
      })

      return {
        source: 'db lock holder',
        data: product,
        status: 200
      }
    } finally {
      await redis.del(lockKey)
    }
  }

  // 4. Bukan yang di lock, tunggu lalu retry baca cache
  const maxRetries = 3

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await sleep(randomJitter(50, 100))

    const cachedAfterWait = await redis.get(cacheKey)

    if (cachedAfterWait) {
      const parsed = JSON.parse(cachedAfterWait)

      return {
        source: parsed === null
          ? `negative-cache after wait attempt ${attempt}`
          : `cache after wait attempt ${attempt}`,
        data: parsed,
        status: parsed === null ? 404 : 200
      }
    }
  }

  return {
    source: 'retry-timeout',
    data: null,
    status: 503
  }
}
