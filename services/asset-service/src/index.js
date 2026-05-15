/**
 * @file index.js
 * @description Asset service entry point.
 * Manages vehicle assets for the Kanban Asset System.
 */

require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");

const { initializePool, closePool } = require("./config/database");
const { initializeRedis }           = require("./config/redis");
const assetRoutes                   = require("./routes/assetRoutes");
const logger                        = require("./utils/logger");

const app  = express();
const PORT = process.env.PORT || 3004;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:      process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("combined", {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message: { success: false, message: "Too many requests" },
}));

// ── Routes ────────────────────────────────────────────────────
app.use("/assets", assetRoutes);

// ── Health Check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({
    success:   true,
    service:   "asset-service",
    status:    "healthy",
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

// ── Start Server ──────────────────────────────────────────────
const startServer = async () => {
  try {
    await initializePool();
    initializeRedis();
    app.listen(PORT, () => {
      logger.info(`✅ Asset service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error(`❌ Failed to start asset service: ${error.message}`);
    process.exit(1);
  }
};

// ── Graceful Shutdown ─────────────────────────────────────────
process.on("SIGTERM", async () => { await closePool(); process.exit(0); });
process.on("SIGINT",  async () => { await closePool(); process.exit(0); });

startServer();
