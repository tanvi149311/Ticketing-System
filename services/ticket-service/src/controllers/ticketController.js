/**
 * @file controllers/ticketController.js
 * @description Handles all Kanban ticket operations.
 * Enforces workflow state machine for ticket status transitions.
 *
 * Ticket Workflow:
 * BACKLOG → IN_PROGRESS → ON_HOLD → IN_PROGRESS → COMPLETE
 *
 * Role permissions:
 * - GET    /tickets         → ALL roles
 * - POST   /tickets         → ADMIN, TEAM_LEAD
 * - PUT    /tickets/:id     → ADMIN, TEAM_LEAD
 * - PATCH  /tickets/:id/status → ALL roles (with restrictions)
 * - DELETE /tickets/:id     → ADMIN only
 */

const oracledb           = require("oracledb");
const { getConnection }  = require("../config/database");
const { getRedisClient } = require("../config/redis");
const logger             = require("../utils/logger");

// ── Cache TTLs ────────────────────────────────────────────────
const BOARD_CACHE_TTL   = 300;   // 5 minutes
const TICKET_CACHE_TTL  = 600;   // 10 minutes

// ── Workflow State Machine ────────────────────────────────────
/**
 * Defines valid ticket status transitions.
 * Technicians can only move tickets they are assigned to.
 * Team Leads and Admins can move any ticket.
 *
 * BACKLOG      → IN_PROGRESS (when assigned to technician/team)
 * IN_PROGRESS  → ON_HOLD, COMPLETE
 * ON_HOLD      → IN_PROGRESS (resume work)
 * COMPLETE     → no further transitions
 */
const VALID_TRANSITIONS = {
  BACKLOG:      ["IN_PROGRESS"],
  IN_PROGRESS:  ["ON_HOLD", "COMPLETE"],
  ON_HOLD:      ["IN_PROGRESS"],
  COMPLETE:     [],             // Terminal state
};

// ── Get Board ─────────────────────────────────────────────────

/**
 * GET /tickets/board
 * Returns all tickets grouped by status for Kanban board view.
 * This is the primary view used by the frontend drag-and-drop board.
 * Results cached per team for 5 minutes.
 *
 * @query {number} teamId - Filter board by team
 */
const getBoard = async (req, res) => {
  let connection;
  try {
    const { teamId }  = req.query;
    const cacheKey    = `tickets:board:${teamId || "all"}`;
    const redis       = getRedisClient();

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    connection = await getConnection();

    // Build WHERE clause
    const conditions = [];
    const binds      = {};

    if (teamId) {
      conditions.push("t.assigned_team = :teamId");
      binds.teamId = parseInt(teamId);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const result = await connection.execute(
      `SELECT
         t.ticket_id,
         t.ticket_number,
         t.title,
         t.description,
         t.status,
         t.priority,
         t.due_date,
         t.site_name,
         t.location,
         t.created_at,
         t.updated_at,
         -- Assigned user
         au.user_id    AS assigned_user_id,
         au.first_name AS assigned_first_name,
         au.last_name  AS assigned_last_name,
         -- Assigned team
         tm.team_id    AS assigned_team_id,
         tm.team_name  AS assigned_team_name,
         -- Asset info
         a.asset_id,
         a.vehicle_id,
         a.license_plate,
         a.vehicle_type,
         a.status      AS asset_status,
         -- Creator
         cu.first_name || ' ' || cu.last_name AS created_by_name
       FROM tickets t
       LEFT JOIN users  au ON t.assigned_to   = au.user_id
       LEFT JOIN teams  tm ON t.assigned_team  = tm.team_id
       LEFT JOIN assets a  ON t.asset_id       = a.asset_id
       LEFT JOIN users  cu ON t.created_by     = cu.user_id
       ${whereClause}
       ORDER BY
         CASE t.priority
           WHEN 'CRITICAL' THEN 1
           WHEN 'HIGH'     THEN 2
           WHEN 'MEDIUM'   THEN 3
           WHEN 'LOW'      THEN 4
         END ASC,
         t.created_at DESC`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    // Group tickets by status for Kanban columns
    const board = {
      BACKLOG:     [],
      IN_PROGRESS: [],
      ON_HOLD:     [],
      COMPLETE:    [],
    };

    result.rows.forEach((row) => {
      const ticket = formatTicket(row);
      if (board[ticket.status]) {
        board[ticket.status].push(ticket);
      }
    });

    const response = {
      success: true,
      data: {
        board,
        counts: {
          BACKLOG:     board.BACKLOG.length,
          IN_PROGRESS: board.IN_PROGRESS.length,
          ON_HOLD:     board.ON_HOLD.length,
          COMPLETE:    board.COMPLETE.length,
          total:       result.rows.length,
        },
      },
    };

    // Cache board
    await redis.setex(cacheKey, BOARD_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getBoard error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get All Tickets ───────────────────────────────────────────

/**
 * GET /tickets
 * Returns paginated, filterable list of tickets.
 * Used for search and list views.
 *
 * @query {string} status     - Filter by status
 * @query {string} priority   - Filter by priority
 * @query {number} assignedTo - Filter by technician
 * @query {number} teamId     - Filter by team
 * @query {number} assetId    - Filter by asset
 * @query {string} search     - Search in title/description
 */
const getAllTickets = async (req, res) => {
  let connection;
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const {
      status,
      priority,
      assignedTo,
      teamId,
      assetId,
      search,
    } = req.query;

    // Build dynamic WHERE clause
    const conditions = [];
    const binds      = { limit, offset };

    if (status) {
      conditions.push("t.status = :status");
      binds.status = status.toUpperCase();
    }
    if (priority) {
      conditions.push("t.priority = :priority");
      binds.priority = priority.toUpperCase();
    }
    if (assignedTo) {
      conditions.push("t.assigned_to = :assignedTo");
      binds.assignedTo = parseInt(assignedTo);
    }
    if (teamId) {
      conditions.push("t.assigned_team = :teamId");
      binds.teamId = parseInt(teamId);
    }
    if (assetId) {
      conditions.push("t.asset_id = :assetId");
      binds.assetId = parseInt(assetId);
    }
    if (search) {
      conditions.push(
        "(UPPER(t.title) LIKE UPPER(:search) OR UPPER(t.description) LIKE UPPER(:search))"
      );
      binds.search = `%${search}%`;
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    connection = await getConnection();

    // Total count
    const countResult = await connection.execute(
      `SELECT COUNT(*) AS total FROM tickets t ${whereClause}`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const total = countResult.rows[0].TOTAL;

    const result = await connection.execute(
      `SELECT
         t.ticket_id,
         t.ticket_number,
         t.title,
         t.status,
         t.priority,
         t.due_date,
         t.site_name,
         t.created_at,
         t.updated_at,
         au.user_id    AS assigned_user_id,
         au.first_name AS assigned_first_name,
         au.last_name  AS assigned_last_name,
         tm.team_id    AS assigned_team_id,
         tm.team_name  AS assigned_team_name,
         a.vehicle_id,
         a.license_plate,
         a.status      AS asset_status
       FROM tickets t
       LEFT JOIN users  au ON t.assigned_to  = au.user_id
       LEFT JOIN teams  tm ON t.assigned_team = tm.team_id
       LEFT JOIN assets a  ON t.asset_id      = a.asset_id
       ${whereClause}
       ORDER BY t.created_at DESC
       OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return res.status(200).json({
      success: true,
      data: {
        tickets: result.rows.map(formatTicket),
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error(`getAllTickets error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Ticket By ID ──────────────────────────────────────────

/**
 * GET /tickets/:id
 * Returns single ticket with full details including
 * asset info and status history.
 */
const getTicketById = async (req, res) => {
  let connection;
  try {
    const { id }   = req.params;
    const cacheKey = `tickets:detail:${id}`;
    const redis    = getRedisClient();

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    connection = await getConnection();

    // Get ticket details
    const ticketResult = await connection.execute(
      `SELECT
         t.ticket_id,
         t.ticket_number,
         t.title,
         t.description,
         t.status,
         t.priority,
         t.due_date,
         t.started_at,
         t.completed_at,
         t.on_hold_at,
         t.site_name,
         t.location,
         t.created_at,
         t.updated_at,
         au.user_id    AS assigned_user_id,
         au.first_name AS assigned_first_name,
         au.last_name  AS assigned_last_name,
         au.email      AS assigned_email,
         tm.team_id    AS assigned_team_id,
         tm.team_name  AS assigned_team_name,
         a.asset_id,
         a.vehicle_id,
         a.license_plate,
         a.vehicle_type,
         a.status      AS asset_status,
         a.current_location AS asset_location,
         cu.first_name || ' ' || cu.last_name AS created_by_name
       FROM tickets t
       LEFT JOIN users  au ON t.assigned_to  = au.user_id
       LEFT JOIN teams  tm ON t.assigned_team = tm.team_id
       LEFT JOIN assets a  ON t.asset_id      = a.asset_id
       LEFT JOIN users  cu ON t.created_by    = cu.user_id
       WHERE t.ticket_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    // Get status history
    const historyResult = await connection.execute(
      `SELECT
         h.history_id,
         h.old_status,
         h.new_status,
         h.change_reason,
         h.changed_at,
         u.first_name || ' ' || u.last_name AS changed_by_name
       FROM ticket_status_history h
       LEFT JOIN users u ON h.changed_by = u.user_id
       WHERE h.ticket_id = :id
       ORDER BY h.changed_at DESC`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const ticket = formatTicketDetail(
      ticketResult.rows[0],
      historyResult.rows
    );

    const response = { success: true, data: ticket };

    await redis.setex(
      cacheKey,
      TICKET_CACHE_TTL,
      JSON.stringify(response)
    );

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getTicketById error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Create Ticket ─────────────────────────────────────────────

/**
 * POST /tickets
 * Creates a new ticket in BACKLOG status.
 * Optionally links an asset and assigns to a team/technician.
 */
const createTicket = async (req, res) => {
  let connection;
  try {
    const {
      title,
      description,
      priority,
      assignedTo,
      assignedTeam,
      assetId,
      dueDate,
      siteName,
      location,
    } = req.body;

    connection = await getConnection();

    // If asset is provided verify it exists and is available
    if (assetId) {
      const assetCheck = await connection.execute(
        `SELECT asset_id, status FROM assets
         WHERE asset_id = :assetId AND is_active = 1`,
        { assetId: parseInt(assetId) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (assetCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Asset not found",
        });
      }
    }

    const result = await connection.execute(
      `INSERT INTO tickets (
         title, description, status, priority,
         assigned_to, assigned_team, asset_id,
         due_date, site_name, location, created_by
       ) VALUES (
         :title, :description, 'BACKLOG', :priority,
         :assignedTo, :assignedTeam, :assetId,
         TO_DATE(:dueDate, 'YYYY-MM-DD'),
         :siteName, :location, :createdBy
       ) RETURNING ticket_id INTO :ticketId`,
      {
        title,
        description:  description  || null,
        priority:     priority     || "MEDIUM",
        assignedTo:   assignedTo   || null,
        assignedTeam: assignedTeam || null,
        assetId:      assetId      || null,
        dueDate:      dueDate      || null,
        siteName:     siteName     || null,
        location:     location     || null,
        createdBy:    req.user.userId,
        ticketId:     { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    const newTicketId = result.outBinds.ticketId[0];

    // Write initial status history
    await writeStatusHistory({
      ticketId:  newTicketId,
      oldStatus: null,
      newStatus: "BACKLOG",
      changedBy: req.user.userId,
      reason:    "Ticket created",
    });

    // Invalidate board cache
    await invalidateBoardCache();

    logger.info(`Ticket created: ID ${newTicketId} by user ${req.user.userId}`);

    return res.status(201).json({
      success: true,
      message: "Ticket created successfully",
      data:    { ticketId: newTicketId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`createTicket error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Update Ticket ─────────────────────────────────────────────

/**
 * PUT /tickets/:id
 * Updates ticket details — title, description, priority,
 * assignment, asset link, due date, location.
 * Does NOT change status (use PATCH /status for that).
 */
const updateTicket = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const {
      title,
      description,
      priority,
      assignedTo,
      assignedTeam,
      assetId,
      dueDate,
      siteName,
      location,
    } = req.body;

    connection = await getConnection();

    const result = await connection.execute(
      `UPDATE tickets SET
         title         = NVL(:title,        title),
         description   = NVL(:description,  description),
         priority      = NVL(:priority,     priority),
         assigned_to   = NVL(:assignedTo,   assigned_to),
         assigned_team = NVL(:assignedTeam, assigned_team),
         asset_id      = NVL(:assetId,      asset_id),
         due_date      = NVL(TO_DATE(:dueDate, 'YYYY-MM-DD'), due_date),
         site_name     = NVL(:siteName,     site_name),
         location      = NVL(:location,     location),
         updated_by    = :updatedBy
       WHERE ticket_id = :id`,
      {
        title:        title        || null,
        description:  description  || null,
        priority:     priority     || null,
        assignedTo:   assignedTo   || null,
        assignedTeam: assignedTeam || null,
        assetId:      assetId      || null,
        dueDate:      dueDate      || null,
        siteName:     siteName     || null,
        location:     location     || null,
        updatedBy:    req.user.userId,
        id:           parseInt(id),
      }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    await connection.commit();

    // Invalidate caches
    await invalidateTicketCache(id);
    await invalidateBoardCache();

    return res.status(200).json({
      success: true,
      message: "Ticket updated successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`updateTicket error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Update Ticket Status ──────────────────────────────────────

/**
 * PATCH /tickets/:id/status
 * Moves a ticket between Kanban columns.
 * Enforces the workflow state machine.
 * Records every transition in ticket_status_history.
 *
 * Technicians can only update tickets assigned to them.
 * Team Leads and Admins can update any ticket.
 */
const updateTicketStatus = async (req, res) => {
  let connection;
  try {
    const { id }             = req.params;
    const { status, reason } = req.body;
    const newStatus          = status.toUpperCase();

    connection = await getConnection();

    // Get current ticket
    const ticketResult = await connection.execute(
      `SELECT ticket_id, status, assigned_to, assigned_team
       FROM tickets
       WHERE ticket_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    const ticket        = ticketResult.rows[0];
    const currentStatus = ticket.STATUS;

    // Technicians can only update their own tickets
    if (
      req.user.role === "TECHNICIAN" &&
      ticket.ASSIGNED_TO !== req.user.userId
    ) {
      return res.status(403).json({
        success: false,
        message: "Technicians can only update tickets assigned to them",
      });
    }

    // Validate transition
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowedTransitions.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid transition: ${currentStatus} → ${newStatus}. Allowed: ${allowedTransitions.join(", ") || "none"}`,
      });
    }

    // Build timestamp updates based on new status
    const timestampUpdates = {
      IN_PROGRESS: "started_at = NVL(started_at, CURRENT_TIMESTAMP),",
      ON_HOLD:     "on_hold_at = CURRENT_TIMESTAMP,",
      COMPLETE:    "completed_at = CURRENT_TIMESTAMP,",
    };

    const tsUpdate = timestampUpdates[newStatus] || "";

    await connection.execute(
      `UPDATE tickets SET
         status     = :newStatus,
         ${tsUpdate}
         updated_by = :updatedBy
       WHERE ticket_id = :id`,
      {
        newStatus,
        updatedBy: req.user.userId,
        id:        parseInt(id),
      }
    );

    await connection.commit();

    // Record status change in history
    await writeStatusHistory({
      ticketId:  parseInt(id),
      oldStatus: currentStatus,
      newStatus,
      changedBy: req.user.userId,
      reason,
    });

    // Invalidate caches
    await invalidateTicketCache(id);
    await invalidateBoardCache();

    logger.info(
      `Ticket ${id} status: ${currentStatus} → ${newStatus} by user ${req.user.userId}`
    );

    return res.status(200).json({
      success: true,
      message: `Ticket moved to ${newStatus}`,
      data: {
        ticketId:  parseInt(id),
        oldStatus: currentStatus,
        newStatus,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`updateTicketStatus error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Delete Ticket ─────────────────────────────────────────────

/**
 * DELETE /tickets/:id
 * Hard deletes a ticket. Admin only.
 * Only BACKLOG tickets can be deleted —
 * in-progress or complete tickets are kept for audit.
 */
const deleteTicket = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await getConnection();

    // Only allow deletion of BACKLOG tickets
    const ticketCheck = await connection.execute(
      `SELECT ticket_id, status FROM tickets
       WHERE ticket_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    if (ticketCheck.rows[0].STATUS !== "BACKLOG") {
      return res.status(400).json({
        success: false,
        message: "Only BACKLOG tickets can be deleted. Move ticket back to BACKLOG first.",
      });
    }

    // Delete comments and history first (FK constraints)
    await connection.execute(
      `DELETE FROM ticket_comments
       WHERE ticket_id = :id`,
      { id: parseInt(id) }
    );

    await connection.execute(
      `DELETE FROM ticket_status_history
       WHERE ticket_id = :id`,
      { id: parseInt(id) }
    );

    await connection.execute(
      `DELETE FROM tickets WHERE ticket_id = :id`,
      { id: parseInt(id) }
    );

    await connection.commit();

    // Invalidate caches
    await invalidateTicketCache(id);
    await invalidateBoardCache();

    logger.info(`Ticket ${id} deleted by admin ${req.user.userId}`);

    return res.status(200).json({
      success: true,
      message: "Ticket deleted successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`deleteTicket error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Helpers ───────────────────────────────────────────────────

/** Formats Oracle ticket row to camelCase for list/board views */
const formatTicket = (row) => ({
  ticketId:     row.TICKET_ID,
  ticketNumber: row.TICKET_NUMBER,
  title:        row.TITLE,
  status:       row.STATUS,
  priority:     row.PRIORITY,
  dueDate:      row.DUE_DATE,
  siteName:     row.SITE_NAME,
  createdAt:    row.CREATED_AT,
  updatedAt:    row.UPDATED_AT,
  assignedTo: row.ASSIGNED_USER_ID ? {
    userId:    row.ASSIGNED_USER_ID,
    firstName: row.ASSIGNED_FIRST_NAME,
    lastName:  row.ASSIGNED_LAST_NAME,
  } : null,
  assignedTeam: row.ASSIGNED_TEAM_ID ? {
    teamId:   row.ASSIGNED_TEAM_ID,
    teamName: row.ASSIGNED_TEAM_NAME,
  } : null,
  asset: row.ASSET_ID ? {
    assetId:      row.ASSET_ID,
    vehicleId:    row.VEHICLE_ID,
    licensePlate: row.LICENSE_PLATE,
    vehicleType:  row.VEHICLE_TYPE,
    status:       row.ASSET_STATUS,
  } : null,
});

/** Formats ticket with full details including history */
const formatTicketDetail = (row, history) => ({
  ...formatTicket(row),
  description:   row.DESCRIPTION,
  location:      row.LOCATION,
  startedAt:     row.STARTED_AT,
  completedAt:   row.COMPLETED_AT,
  onHoldAt:      row.ON_HOLD_AT,
  createdByName: row.CREATED_BY_NAME,
  asset: row.ASSET_ID ? {
    assetId:         row.ASSET_ID,
    vehicleId:       row.VEHICLE_ID,
    licensePlate:    row.LICENSE_PLATE,
    vehicleType:     row.VEHICLE_TYPE,
    status:          row.ASSET_STATUS,
    currentLocation: row.ASSET_LOCATION,
  } : null,
  statusHistory: history.map((h) => ({
    historyId:     h.HISTORY_ID,
    oldStatus:     h.OLD_STATUS,
    newStatus:     h.NEW_STATUS,
    changeReason:  h.CHANGE_REASON,
    changedAt:     h.CHANGED_AT,
    changedByName: h.CHANGED_BY_NAME,
  })),
});

/**
 * Records a ticket status transition in history table.
 * Called after every status change.
 */
const writeStatusHistory = async ({
  ticketId,
  oldStatus,
  newStatus,
  changedBy,
  reason,
}) => {
  let connection;
  try {
    connection = await getConnection();
    await connection.execute(
      `INSERT INTO ticket_status_history (
         ticket_id, old_status, new_status,
         changed_by, change_reason
       ) VALUES (
         :ticketId, :oldStatus, :newStatus,
         :changedBy, :reason
       )`,
      {
        ticketId,
        oldStatus: oldStatus || null,
        newStatus,
        changedBy,
        reason:    reason    || null,
      }
    );
    await connection.commit();
  } catch (error) {
    logger.error(`writeStatusHistory error: ${error.message}`);
  } finally {
    if (connection) await connection.close();
  }
};

const invalidateTicketCache = async (id) => {
  const redis = getRedisClient();
  await redis.del(`tickets:detail:${id}`);
};

const invalidateBoardCache = async () => {
  const redis = getRedisClient();
  const keys  = await redis.keys("tickets:board:*");
  if (keys.length > 0) await redis.del(...keys);
};

module.exports = {
  getBoard,
  getAllTickets,
  getTicketById,
  createTicket,
  updateTicket,
  updateTicketStatus,
  deleteTicket,
};