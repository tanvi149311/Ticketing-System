/**
 * @file websocket/wsServer.js
 * @description WebSocket server for real-time notifications.
 *
 * How it works:
 * 1. Client connects with JWT token in query string
 * 2. Server verifies token and registers the connection
 * 3. Other services publish events to Redis pub/sub
 * 4. This server subscribes to Redis and broadcasts to clients
 *
 * Redis Pub/Sub channels:
 * - ticket:events  → ticket status changes, new tickets
 * - asset:events   → asset status changes, assignments
 *
 * WebSocket rooms (stored in Redis):
 * - ws:room:{boardId} → set of userIds watching a board
 */

const WebSocket = require("ws");
const jwt       = require("jsonwebtoken");
const { getRedisClient } = require("../config/redis");
const logger    = require("../utils/logger");

// ── Connection Registry ───────────────────────────────────────
/**
 * Maps userId → WebSocket connection.
 * Allows us to send targeted messages to specific users.
 */
const connections = new Map();

// ── Initialize WebSocket Server ───────────────────────────────

/**
 * Creates and configures the WebSocket server.
 * Attaches to the existing HTTP server for shared port.
 *
 * @param {http.Server} server - Express HTTP server
 */
const initializeWebSocket = (server) => {
  const wss = new WebSocket.Server({ server, path: "/ws" });

  // ── Subscribe to Redis channels ───────────────────────────
  const subscriber = getRedisClient().duplicate();

  subscriber.subscribe("ticket:events", "asset:events", (err) => {
    if (err) {
      logger.error(`Redis subscribe error: ${err.message}`);
    } else {
      logger.info("✅ WebSocket subscribed to Redis channels");
    }
  });

  // Broadcast Redis messages to relevant WebSocket clients
  subscriber.on("message", (channel, message) => {
    try {
      const event = JSON.parse(message);
      broadcastEvent(channel, event);
    } catch (error) {
      logger.error(`WS broadcast error: ${error.message}`);
    }
  });

  // ── Handle new connections ────────────────────────────────
  wss.on("connection", async (ws, req) => {
    // Extract token from query string: ws://host/ws?token=xxx
    const url       = new URL(req.url, "ws://localhost");
    const token     = url.searchParams.get("token");

    if (!token) {
      ws.close(1008, "Token required");
      return;
    }

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      ws.close(1008, "Invalid token");
      return;
    }

    const { userId, role, teamId } = decoded;

    // Register connection
    connections.set(userId, ws);

    logger.info(`WS connected: userId=${userId} role=${role}`);

    // Send connection confirmation
    sendToClient(ws, {
      type:      "CONNECTION_CONFIRMED",
      userId,
      timestamp: new Date().toISOString(),
    });

    // ── Handle incoming messages ──────────────────────────
    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Client can subscribe to a specific board
        if (message.type === "SUBSCRIBE_BOARD") {
          await subscribeToBoard(userId, message.boardId);
          sendToClient(ws, {
            type:    "SUBSCRIBED",
            boardId: message.boardId,
          });
        }

        // Client can unsubscribe from a board
        if (message.type === "UNSUBSCRIBE_BOARD") {
          await unsubscribeFromBoard(userId, message.boardId);
        }

        // Ping/pong for connection keep-alive
        if (message.type === "PING") {
          sendToClient(ws, { type: "PONG" });
        }
      } catch (error) {
        logger.error(`WS message error: ${error.message}`);
      }
    });

    // ── Handle disconnection ──────────────────────────────
    ws.on("close", async () => {
      connections.delete(userId);
      await cleanupUserRooms(userId);
      logger.info(`WS disconnected: userId=${userId}`);
    });

    ws.on("error", (error) => {
      logger.error(`WS error for userId=${userId}: ${error.message}`);
      connections.delete(userId);
    });
  });

  logger.info("✅ WebSocket server initialized");
  return wss;
};

// ── Broadcasting ──────────────────────────────────────────────

/**
 * Broadcasts an event to all relevant connected clients.
 * Ticket events go to users watching the relevant board.
 * Asset events go to the assigned technician specifically.
 *
 * @param {string} channel - Redis channel name
 * @param {Object} event   - Event payload
 */
const broadcastEvent = async (channel, event) => {
  try {
    const redis = getRedisClient();

    if (channel === "ticket:events") {
      // Broadcast to all users watching this team's board
      const boardKey   = `ws:room:${event.teamId || "global"}`;
      const watchers   = await redis.smembers(boardKey);

      watchers.forEach((userId) => {
        const ws = connections.get(parseInt(userId));
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendToClient(ws, event);
        }
      });
    }

    if (channel === "asset:events") {
      // Send directly to the assigned technician
      if (event.assignedTo) {
        const ws = connections.get(event.assignedTo);
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendToClient(ws, event);
        }
      }

      // Also broadcast to all admins and team leads
      connections.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
          sendToClient(ws, event);
        }
      });
    }
  } catch (error) {
    logger.error(`broadcastEvent error: ${error.message}`);
  }
};

/**
 * Publishes an event to Redis so all service instances
 * can broadcast it to their connected clients.
 * Called by other services via HTTP to trigger WS events.
 *
 * @param {string} channel - "ticket:events" | "asset:events"
 * @param {Object} event   - Event payload to broadcast
 */
const publishEvent = async (channel, event) => {
  try {
    const redis = getRedisClient();
    await redis.publish(channel, JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    logger.error(`publishEvent error: ${error.message}`);
  }
};

// ── Room Management ───────────────────────────────────────────

/**
 * Adds a user to a board's WebSocket room.
 * Users in a room receive real-time updates for that board.
 *
 * @param {number} userId
 * @param {string} boardId
 */
const subscribeToBoard = async (userId, boardId) => {
  const redis = getRedisClient();
  await redis.sadd(`ws:room:${boardId}`, userId.toString());
  // Track which rooms this user is in for cleanup
  await redis.sadd(`ws:user:${userId}:rooms`, boardId);
};

/**
 * Removes a user from a board's WebSocket room.
 *
 * @param {number} userId
 * @param {string} boardId
 */
const unsubscribeFromBoard = async (userId, boardId) => {
  const redis = getRedisClient();
  await redis.srem(`ws:room:${boardId}`, userId.toString());
  await redis.srem(`ws:user:${userId}:rooms`, boardId);
};

/**
 * Removes user from all rooms on disconnect.
 * Prevents ghost subscribers in Redis sets.
 *
 * @param {number} userId
 */
const cleanupUserRooms = async (userId) => {
  const redis = getRedisClient();
  const rooms = await redis.smembers(`ws:user:${userId}:rooms`);

  for (const boardId of rooms) {
    await redis.srem(`ws:room:${boardId}`, userId.toString());
  }
  await redis.del(`ws:user:${userId}:rooms`);
};

// ── Helpers ───────────────────────────────────────────────────

/**
 * Safely sends a JSON message to a WebSocket client.
 * Catches errors if connection closes mid-send.
 *
 * @param {WebSocket} ws
 * @param {Object}    data
 */
const sendToClient = (ws, data) => {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    logger.error(`sendToClient error: ${error.message}`);
  }
};

module.exports = { initializeWebSocket, publishEvent };