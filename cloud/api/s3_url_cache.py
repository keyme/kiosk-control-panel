# Shared cache for S3 presigned URLs.
# Keeps URLs stable across repeated API calls so the browser can cache images.

import threading

from cachetools import TTLCache

PRESIGNED_EXPIRES = 3600  # 1 hour

_cache: TTLCache = TTLCache(maxsize=4096, ttl=PRESIGNED_EXPIRES - 60)
_lock = threading.Lock()


def get_presigned_url(s3_client, bucket: str, key: str) -> str:
    """Return a cached presigned GET URL for *bucket*/*key*, generating one on miss."""
    cache_key = (bucket, key)
    with _lock:
        cached = _cache.get(cache_key)
        if cached is not None:
            return cached
    url = s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=PRESIGNED_EXPIRES,
    )
    with _lock:
        _cache[cache_key] = url
    return url
