/**
 * @file utils/tokenUtils.js
 * @description JWT token generation and verification utilities.
 *
 * Two token types:
 * - Access token: short-lived (15min), used for API requests
 * - Refresh token: long-lived (7d), used to get new access tokens
 */

const jwt    = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { getRedisClient } = require("../config/redis");
const logger = require("./logger");

// ── TTL Constants ─────────────────────────────────────────────
const SESSION_TTL_SECONDS  = 60 * 60 * 24;       // 24 hours
const BLACKLIST_TTL_SECONDS = 60 * 60 * 24;       // 24 hours

/**
 * Generates an access token for API authentication.
 * Short-lived to minimize risk if token is compromised.
 *
 * @param {Object} payload - User data to encode
 * @param {number} payload.userId
 * @param {string} payload.role
 * @param {number} payload.teamId
 */
const generateAccessToken = (payload) => {
  return jwt.sign(
    {
      userId: payload.userId,
      role:   payload.role,
      teamId: payload.teamId,
      type:   "access",
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "15m",
      jwtid:     uuidv4(), // Unique ID per token
    }
  );
};

/**
 * Generates a refresh token for obtaining new access tokens.
 * Longer-lived but can be revoked via Redis blacklist.
 *
 * @param {Object} payload - User data to encode
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(
    {
      userId: payload.userId,
      type:   "refresh",
    },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
      jwtid:     uuidv4(),
    }
  );
};

/**
 * Verifies an access token and returns the decoded payload.
 * Returns null if token is invalid or expired.
 *
 * @param {string} token - JWT access token
 */
const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    logger.debug(`Token verification failed: ${error.message}`);
    return null;
  }
};

/**
 * Verifies a refresh token and returns the decoded payload.
 *
 * @param {string} token - JWT refresh token
 */
const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch (error) {
    logger.debug(`Refresh token verification failed: ${error.message}`);
    return null;
  }
};

/**
 * Stores active session in Redis.
 * Allows us to invalidate all sessions for a user if needed.
 *
 * @param {number} userId
 * @param {string} token - Access token
 */
const storeSession = async (userId, token) => {
  const redis = getRedisClient();
  await redis.setex(
    `auth:session:${userId}`,
    SESSION_TTL_SECONDS,
    token
  );
};

/**
 * Blacklists a token in Redis (on logout).
 * Even if the JWT hasn't expired, it will be rejected.
 *
 * @param {string} token - Token to blacklist
 * @param {string} jti   - JWT ID (from decoded token)
 */
const blacklistToken = async (token, jti) => {
  const redis = getRedisClient();
  await redis.setex(
    `auth:blacklist:${jti}`,
    BLACKLIST_TTL_SECONDS,
    "blacklisted"
  );
};

/**
 * Checks if a token has been blacklisted.
 *
 * @param {string} jti - JWT ID from decoded token
 * @returns {boolean}
 */
const isTokenBlacklisted = async (jti) => {
  const redis = getRedisClient();
  const result = await redis.get(`auth:blacklist:${jti}`);
  return result !== null;
};

/**
 * Removes session from Redis on logout.
 *
 * @param {number} userId
 */
const removeSession = async (userId) => {
  const redis = getRedisClient();
  await redis.del(`auth:session:${userId}`);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  storeSession,
  blacklistToken,
  isTokenBlacklisted,
  removeSession,
};
