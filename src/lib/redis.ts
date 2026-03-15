import { Redis, Cluster } from "ioredis";

let _redis: Redis | Cluster | null = null;

/**
 * Canonical Redis connection config derived from REDIS_URL (preferred) or
 * REDIS_HOST / REDIS_PORT fallback.  Used by the main ioredis client **and**
 * BullMQ queues / workers so every component connects to the same instance.
 */
export function getRedisConfig(): { host: string; port: number; password?: string } {
  if (process.env.REDIS_URL) {
    const url = new URL(process.env.REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port || "6379"),
      ...(url.password ? { password: url.password } : {}),
    };
  }
  return {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  };
}

/**
 * Parse REDIS_CLUSTER_NODES env var into ioredis cluster node configs.
 * Format: "host1:port1,host2:port2,host3:port3"
 */
function parseClusterNodes(): { host: string; port: number }[] | null {
  const nodes = process.env.REDIS_CLUSTER_NODES;
  if (!nodes) return null;
  return nodes.split(",").map((n) => {
    const [host, port] = n.trim().split(":");
    return { host, port: parseInt(port || "6379") };
  });
}

/**
 * Exponential backoff retry strategy.
 * Starts at 200ms, caps at 30s, gives up after 20 retries (~5 min total).
 */
function retryStrategy(times: number): number | null {
  if (times > 20) return null; // stop retrying
  return Math.min(times * 200, 30_000);
}

export function getRedis(): Redis | Cluster | null {
  if (!_redis) {
    const clusterNodes = parseClusterNodes();

    if (clusterNodes) {
      // Redis Cluster mode
      const password = process.env.REDIS_PASSWORD;
      _redis = new Cluster(clusterNodes, {
        redisOptions: {
          ...(password ? { password } : {}),
          maxRetriesPerRequest: 3,
        },
        clusterRetryStrategy: retryStrategy,
        enableReadyCheck: true,
      });
    } else {
      // Single-node mode
      const url = process.env.REDIS_URL ?? "redis://localhost:6379";
      _redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy,
        enableReadyCheck: true,
        reconnectOnError(err) {
          // Reconnect on READONLY errors (failover scenario)
          return err.message.includes("READONLY");
        },
      });
    }
  }
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
