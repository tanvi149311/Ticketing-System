/**
 * @file config/redis.js
 * @description Redis client configuration for session management.
 *
 * Redis is used for:
 * - Storing active JWT sessions (auth:session:{userId})
 * - Blacklisting logged-out tokens (auth:blacklist:{token})
 * - Fast token validation without DB hits
 */

const Redis = require("ioredis");

let redisClient;

/**
 * Creates and returns the Redis client.
 * Handles reconnection automatically via ioredis.
 */
const initializeRedis = () => {
  redisClient = new Redis({
    host:     process.env.REDIS_HOST     || "localhost",
    port:     parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,

    // Retry strategy — exponential backoff
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },

    // Reconnect on connection loss
    lazyConnect:         false,
    enableReadyCheck:    true,
    maxRetriesPerRequest: 3,
  });

  redisClient.on("connect", () => {
    console.log("✅ Redis connected");
  });

  redisClient.on("error", (error) => {
    console.error("❌ Redis error:", error.message);
  });

  redisClient.on("reconnecting", () => {
    console.log("🔄 Redis reconnecting...");
  });

  return redisClient;
};

/**
 * Returns the active Redis client.
 * Throws if Redis has not been initialized.
 */
const getRedisClient = () => {
  if (!redisClient) {
    throw new Error("Redis not initialized. Call initializeRedis() first.");
  }
  return redisClient;
};

module.exports = { initializeRedis, getRedisClient };
