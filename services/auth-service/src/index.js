/**
 * @file index.js
 * @description Auth service entry point.
 * Sets up Express, middleware, routes, and starts the server.
 */

require("dotenv").config();

const express      = require("express");
const cors         = require("cors");
const helmet       = require("helmet");
const morgan       = require("morgan");
const rateLimit    = require("express-rate-limit");

const { initializePool, closePool } = require("./config/database");
const { initializeRedis }           = require("./config/redis");
const authRoutes                    = require("./routes/authRoutes");
const logger                        = require("./utils/logger");

// ── App Setup ─────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security Middleware ───────────────────────────────────────
// helmet sets secure HTTP headers
app.use(helmet());

// CORS — allow requests from frontend
app.use(cors({
  origin:      process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true,
}));

// ── Request Parsing ───────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── HTTP Request Logging ──────────────────────────────────────
app.use(morgan("combined", {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Rate Limiting ─────────────────────────────────────────────
// Prevents brute force attacks on login endpoint
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});
app.use(limiter);

// ── Routes ────────────────────────────────────────────────────
app.use("/auth", authRoutes);

// ── Health Check ──────────────────────────────────────────────
// Used by Docker and load balancers to verify service is alive
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "auth-service",
    status:  "healthy",
    timestamp: new Date().toISOString(),
  });
});

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// ── Server Startup ────────────────────────────────────────────
const startServer = async () => {
  try {
    // Initialize DB pool and Redis before accepting requests
    await initializePool();
    initializeRedis();

    app.listen(PORT, () => {
      logger.info(`✅ Auth service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(`❌ Failed to start auth service: ${error.message}`);
    process.exit(1);
  }
};

// ── Graceful Shutdown ─────────────────────────────────────────
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received — shutting down gracefully");
  await closePool();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received — shutting down gracefully");
  await closePool();
  process.exit(0);
});

startServer();
