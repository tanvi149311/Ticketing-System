/**
 * @file controllers/notificationController.js
 * @description Handles creating, sending, and managing notifications.
 *
 * Flow:
 * 1. Other services POST to /notifications/send
 * 2. We save to DB, send email, publish WebSocket event
 * 3. Frontend polls GET /notifications/:userId for unread count
 */

const oracledb           = require("oracledb");
const { getConnection }  = require("../config/database");
const { getRedisClient } = require("../config/redis");
const { getTransporter } = require("../config/email");
const templates          = require("../utils/emailTemplates");
const { publishEvent }   = require("../websocket/wsServer");
const logger             = require("../utils/logger");

// ── Cache TTL ─────────────────────────────────────────────────
const NOTIF_CACHE_TTL = 3600; // 1 hour

// ── Send Notification ─────────────────────────────────────────

/**
 * POST /notifications/send
 * Called internally by other microservices.
 * Creates DB record, sends email, broadcasts WebSocket event.
 *
 * @body {string} type          - Notification type
 * @body {number} userId        - Recipient user ID
 * @body {string} title         - Notification title
 * @body {string} message       - Notification body
 * @body {string} referenceType - 'TICKET' | 'ASSET'
 * @body {number} referenceId   - ID of related record
 * @body {Object} emailData     - Data for email template
 * @body {Object} wsEvent       - Data for WebSocket broadcast
 */
const sendNotification = async (req, res) => {
  let connection;
  try {
    const {
      type,
      userId,
      title,
      message,
      referenceType,
      referenceId,
      emailData,
      wsEvent,
    } = req.body;

    connection = await getConnection();

    // Get user email for notification
    const userResult = await connection.execute(
      `SELECT user_id, email, first_name, last_name
       FROM users
       WHERE user_id = :userId AND is_active = 1`,
      { userId: parseInt(userId) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = userResult.rows[0];

    // Save notification to DB
    const result = await connection.execute(
      `INSERT INTO notifications (
         user_id, type, title, message,
         reference_type, reference_id
       ) VALUES (
         :userId, :type, :title, :message,
         :referenceType, :referenceId
       ) RETURNING notification_id INTO :notifId`,
      {
        userId:        parseInt(userId),
        type,
        title,
        message,
        referenceType: referenceType || null,
        referenceId:   referenceId   || null,
        notifId:       { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    const notifId = result.outBinds.notifId[0];

    // ── Send Email ────────────────────────────────────────
    if (emailData) {
      await sendEmail(type, user, emailData);

      // Mark email as sent in DB
      await connection.execute(
        `UPDATE notifications SET
           email_sent    = 1,
           email_sent_at = CURRENT_TIMESTAMP
         WHERE notification_id = :notifId`,
        { notifId }
      );
      await connection.commit();
    }

    // ── Publish WebSocket Event ───────────────────────────
    if (wsEvent) {
      const channel = wsEvent.channel || "ticket:events";
      await publishEvent(channel, {
        type:            wsEvent.type,
        notificationId:  notifId,
        userId,
        ...wsEvent.data,
      });
    }

    // Invalidate unread cache for this user
    const redis = getRedisClient();
    await redis.del(`notif:unread:${userId}`);

    logger.info(`Notification sent: type=${type} userId=${userId}`);

    return res.status(201).json({
      success: true,
      message: "Notification sent",
      data:    { notificationId: notifId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`sendNotification error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Notifications ─────────────────────────────────────────

/**
 * GET /notifications/:userId
 * Returns paginated notifications for a user.
 * Unread count cached in Redis for 1 hour.
 *
 * @query {number}  page   - Page number
 * @query {number}  limit  - Results per page
 * @query {boolean} unread - Filter unread only
 */
const getNotifications = async (req, res) => {
  let connection;
  try {
    const { userId }  = req.params;
    const page        = parseInt(req.query.page)  || 1;
    const limit       = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset      = (page - 1) * limit;
    const unreadOnly  = req.query.unread === "true";

    // Verify requesting user can only see their own notifications
    if (
      req.user.userId !== parseInt(userId) &&
      req.user.role   !== "ADMIN"
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    connection = await getConnection();

    const whereClause = unreadOnly
      ? "WHERE n.user_id = :userId AND n.is_read = 0"
      : "WHERE n.user_id = :userId";

    const binds = { userId: parseInt(userId), limit, offset };

    // Get unread count from cache or DB
    const redis    = getRedisClient();
    const cacheKey = `notif:unread:${userId}`;
    let unreadCount;

    const cached = await redis.get(cacheKey);
    if (cached) {
      unreadCount = parseInt(cached);
    } else {
      const countResult = await connection.execute(
        `SELECT COUNT(*) AS total FROM notifications
         WHERE user_id = :userId AND is_read = 0`,
        { userId: parseInt(userId) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      unreadCount = countResult.rows[0].TOTAL;
      await redis.setex(cacheKey, NOTIF_CACHE_TTL, unreadCount.toString());
    }

    // Get total count
    const totalResult = await connection.execute(
      `SELECT COUNT(*) AS total FROM notifications n ${whereClause}`,
      { userId: parseInt(userId) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const total = totalResult.rows[0].TOTAL;

    // Get notifications
    const result = await connection.execute(
      `SELECT
         n.notification_id,
         n.type,
         n.title,
         n.message,
         n.reference_type,
         n.reference_id,
         n.is_read,
         n.read_at,
         n.created_at
       FROM notifications n
       ${whereClause}
       ORDER BY n.created_at DESC
       OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return res.status(200).json({
      success: true,
      data: {
        notifications: result.rows.map((row) => ({
          notificationId: row.NOTIFICATION_ID,
          type:           row.TYPE,
          title:          row.TITLE,
          message:        row.MESSAGE,
          referenceType:  row.REFERENCE_TYPE,
          referenceId:    row.REFERENCE_ID,
          isRead:         row.IS_READ === 1,
          readAt:         row.READ_AT,
          createdAt:      row.CREATED_AT,
        })),
        unreadCount,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error(`getNotifications error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Mark As Read ──────────────────────────────────────────────

/**
 * PATCH /notifications/:id/read
 * Marks a single notification as read.
 * Invalidates unread count cache.
 */
const markAsRead = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await getConnection();

    const result = await connection.execute(
      `UPDATE notifications SET
         is_read = 1,
         read_at = CURRENT_TIMESTAMP
       WHERE notification_id = :id
       AND   user_id         = :userId`,
      {
        id:     parseInt(id),
        userId: req.user.userId,
      }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    await connection.commit();

    // Invalidate unread cache
    const redis = getRedisClient();
    await redis.del(`notif:unread:${req.user.userId}`);

    return res.status(200).json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`markAsRead error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Mark All As Read ──────────────────────────────────────────

/**
 * PATCH /notifications/read-all
 * Marks all notifications as read for the current user.
 */
const markAllAsRead = async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    await connection.execute(
      `UPDATE notifications SET
         is_read = 1,
         read_at = CURRENT_TIMESTAMP
       WHERE user_id = :userId
       AND   is_read = 0`,
      { userId: req.user.userId }
    );

    await connection.commit();

    // Invalidate unread cache
    const redis = getRedisClient();
    await redis.del(`notif:unread:${req.user.userId}`);

    return res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`markAllAsRead error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Helpers ───────────────────────────────────────────────────

/**
 * Sends an email using the correct template for the
 * notification type.
 *
 * @param {string} type      - Notification type
 * @param {Object} user      - Recipient user object
 * @param {Object} emailData - Template-specific data
 */
const sendEmail = async (type, user, emailData) => {
  try {
    const transporter = getTransporter();

    // Select correct template
    const templateMap = {
      TICKET_ASSIGNED:       templates.ticketAssigned,
      TICKET_STATUS_CHANGED: templates.ticketStatusChanged,
      ASSET_ASSIGNED:        templates.assetAssigned,
      ASSET_STATUS_CHANGED:  templates.assetStatusChanged,
    };

    const templateFn = templateMap[type];
    if (!templateFn) return;

    const { subject, html } = templateFn({
      recipientName: `${user.FIRST_NAME} ${user.LAST_NAME}`,
      ...emailData,
    });

    await transporter.sendMail({
      from:    `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM}>`,
      to:      user.EMAIL,
      subject,
      html,
    });

    logger.info(`Email sent: type=${type} to=${user.EMAIL}`);
  } catch (error) {
    // Email failure should not break the notification flow
    logger.error(`sendEmail error: ${error.message}`);
  }
};

module.exports = {
  sendNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
};