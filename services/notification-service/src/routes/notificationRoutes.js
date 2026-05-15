/**
 * @file routes/notificationRoutes.js
 * @description Notification service routes.
 */

const express  = require("express");
const router   = express.Router();

const {
  sendNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
} = require("../controllers/notificationController");

const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

// ── Routes ────────────────────────────────────────────────────

/**
 * POST /notifications/send
 * Internal endpoint called by other services.
 * Restricted to service-to-service calls (Admin role).
 */
router.post(
  "/send",
  authenticate,
  authorize("ADMIN"),
  sendNotification
);

/**
 * GET /notifications/:userId
 * Get notifications for a user.
 * Users can only see their own; Admins can see any.
 */
router.get("/:userId", authenticate, getNotifications);

/**
 * PATCH /notifications/read-all
 * Mark all notifications as read.
 */
router.patch("/read-all", authenticate, markAllAsRead);

/**
 * PATCH /notifications/:id/read
 * Mark single notification as read.
 */
router.patch("/:id/read", authenticate, markAsRead);

module.exports = router;