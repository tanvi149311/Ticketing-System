/**
 * @file config/database.js
 * @description Oracle database connection pool configuration.
 * Uses connection pooling for performance at scale (100-1000 users).
 * Pool reuses connections instead of creating new ones per request.
 */

const oracledb = require("oracledb");

// ── Oracle Client Config ──────────────────────────────────────
// Fetch rows as objects { column: value } instead of arrays
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// Auto-commit is OFF — we control transactions explicitly
oracledb.autoCommit = false;

// ── Connection Pool ───────────────────────────────────────────
let pool;

/**
 * Initializes the Oracle connection pool.
 * Call once at application startup.
 *
 * Pool keeps connections warm, avoiding the overhead
 * of creating a new connection on every request.
 */
const initializePool = async () => {
  try {
    pool = await oracledb.createPool({
      user:             process.env.DB_USER,
      password:         process.env.DB_PASSWORD,
      connectionString: process.env.DB_CONNECTION_STRING,

      // Pool sizing for 100-1000 users
      poolMin:          2,    // Keep 2 connections always open
      poolMax:          10,   // Max 10 concurrent connections
      poolIncrement:    2,    // Add 2 connections when needed
      poolTimeout:      60,   // Close idle connections after 60s

      poolAlias: "default",
    });

    console.log("✅ Oracle connection pool initialized");
    return pool;
  } catch (error) {
    console.error("❌ Oracle pool initialization failed:", error.message);
    throw error;
  }
};

/**
 * Returns a connection from the pool.
 * Always release the connection back after use.
 *
 * @example
 * const connection = await getConnection();
 * try {
 *   await connection.execute(sql, params);
 * } finally {
 *   await connection.close(); // returns to pool
 * }
 */
const getConnection = async () => {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initializePool() first.");
  }
  return await pool.getConnection();
};

/**
 * Gracefully closes the connection pool.
 * Call on application shutdown.
 */
const closePool = async () => {
  try {
    await pool.close(10); // 10s drain timeout
    console.log("✅ Oracle connection pool closed");
  } catch (error) {
    console.error("❌ Error closing Oracle pool:", error.message);
  }
};

module.exports = { initializePool, getConnection, closePool };
