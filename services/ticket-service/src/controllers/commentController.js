/**
 * @file controllers/commentController.js
 * @description Handles ticket comments.
 * All authenticated users can view and add comments.
 * Users can only edit/delete their own comments.
 */

const oracledb           = require("oracledb");
const { getConnection }  = require("../config/database");
const { getRedisClient } = require("../config/redis");
const logger             = require("../utils/logger");

// ── Get Comments ──────────────────────────────────────────────

/**
 * GET /tickets/:id/comments
 * Returns all comments for a ticket ordered by date.
 */
const getComments = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         c.comment_id,
         c.comment,
         c.is_edited,
         c.edited_at,
         c.created_at,
         u.user_id,
         u.first_name,
         u.last_name,
         u.email,
         u.role
       FROM ticket_comments c
       LEFT JOIN users u ON c.user_id = u.user_id
       WHERE c.ticket_id = :id
       ORDER BY c.created_at ASC`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return res.status(200).json({
      success: true,
      data: {
        ticketId: parseInt(id),
        comments: result.rows.map((row) => ({
          commentId: row.COMMENT_ID,
          comment:   row.COMMENT,
          isEdited:  row.IS_EDITED === 1,
          editedAt:  row.EDITED_AT,
          createdAt: row.CREATED_AT,
          user: {
            userId:    row.USER_ID,
            firstName: row.FIRST_NAME,
            lastName:  row.LAST_NAME,
            email:     row.EMAIL,
            role:      row.ROLE,
          },
        })),
      },
    });
  } catch (error) {
    logger.error(`getComments error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Add Comment ───────────────────────────────────────────────

/**
 * POST /tickets/:id/comments
 * Adds a new comment to a ticket.
 * Invalidates ticket detail cache so comment appears immediately.
 */
const addComment = async (req, res) => {
  let connection;
  try {
    const { id }      = req.params;
    const { comment } = req.body;

    // Verify ticket exists
    connection = await getConnection();

    const ticketCheck = await connection.execute(
      `SELECT ticket_id FROM tickets WHERE ticket_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    const result = await connection.execute(
      `INSERT INTO ticket_comments (ticket_id, user_id, comment)
       VALUES (:ticketId, :userId, :comment)
       RETURNING comment_id INTO :commentId`,
      {
        ticketId:  parseInt(id),
        userId:    req.user.userId,
        comment,
        commentId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    // Invalidate ticket cache so comment count updates
    const redis = getRedisClient();
    await redis.del(`tickets:detail:${id}`);

    const newCommentId = result.outBinds.commentId[0];

    logger.info(`Comment ${newCommentId} added to ticket ${id}`);

    return res.status(201).json({
      success: true,
      message: "Comment added successfully",
      data:    { commentId: newCommentId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`addComment error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Edit Comment ──────────────────────────────────────────────

/**
 * PUT /tickets/:ticketId/comments/:commentId
 * Edits an existing comment.
 * Users can only edit their own comments.
 */
const editComment = async (req, res) => {
  let connection;
  try {
    const { commentId } = req.params;
    const { comment }   = req.body;

    connection = await getConnection();

    // Verify ownership
    const existing = await connection.execute(
      `SELECT comment_id, user_id FROM ticket_comments
       WHERE comment_id = :commentId`,
      { commentId: parseInt(commentId) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Comment not found",
      });
    }

    // Only comment owner or admin can edit
    if (
      existing.rows[0].USER_ID !== req.user.userId &&
      req.user.role !== "ADMIN"
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own comments",
      });
    }

    await connection.execute(
      `UPDATE ticket_comments SET
         comment   = :comment,
         is_edited = 1,
         edited_at = CURRENT_TIMESTAMP
       WHERE comment_id = :commentId`,
      { comment, commentId: parseInt(commentId) }
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Comment updated successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`editComment error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

module.exports = { getComments, addComment, editComment };