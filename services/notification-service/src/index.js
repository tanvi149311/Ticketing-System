/**
 * @file index.js
 * @description Notification service entry point.
 * Handles email notifications and WebSocket real-time events.
 */

require("dotenv").config();

const http      = require("http");
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");

const { initializePool, closePool } = require("./config/database");
const { initializeRedis }           = require("./config/redis");
const { initializeEmail }           = require("./config/email");
const { initializeWebSocket }       = require("./websocket/wsServer");
const notificationRoutes            = require("./routes/notificationRoutes");
const logger                        = require("./utils/logger");

const app    = express();
const PORT   = process.env.PORT    || 3005;

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
  message:  { success: false, message: "Too many requests" },
}));

// ── Routes ────────────────────────────────────────────────────
app.use("/notifications", notificationRoutes);

// ── Health Check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({
    success:   true,
    service:   "notification-service",
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
    // Initialize all dependencies
    await initializePool();
    initializeRedis();
    await initializeEmail();

    // Create HTTP server — shared by Express + WebSocket
    const server = http.createServer(app);

    // Attach WebSocket server to same HTTP server
    initializeWebSocket(server);

    server.listen(PORT, () => {
      logger.info(`✅ Notification service running on port ${PORT}`);
      logger.info(`✅ WebSocket server running on ws://localhost:${PORT}/ws`);
    });
  } catch (error) {
    logger.error(`❌ Failed to start notification service: ${error.message}`);
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