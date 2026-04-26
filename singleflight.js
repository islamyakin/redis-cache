async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getProductSafe(id) {
  const cacheKey = `product:${id}`
  const lockKey = `lock:product:${id}`

  const cached = await redis.get(cacheKey)
  if (cached) {
    return {
      source: 'cache',
      data: JSON.parse(cached)
    }
  }

  const lockAcquired = await redis.set(lockKey, '1', {
    NX: true,
    EX: 5
  })

  if (lockAcquired) {
    try {
      const product = await fetchProduct(id)

      await redis.set(cacheKey, JSON.stringify(product), {
        EX: 10
      })

      return {
        source: 'db (lock holder)',
        data: product
      }
    } finally {
      await redis.del(lockKey)
    }
  }

  const maxRetries = 3
  const retryDelayMs = 50

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await sleep(retryDelayMs)

    const cachedAfterWait = await redis.get(cacheKey)

    if (cachedAfterWait) {
      return {
        source: `cache (after wait, attempt ${attempt})`,
        data: JSON.parse(cachedAfterWait)
      }
    }
  }

  throw new Error(`Product ${id} is still not available in cache after retry`)
}
