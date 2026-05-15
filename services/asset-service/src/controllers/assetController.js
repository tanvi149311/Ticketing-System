/**
 * @file controllers/assetController.js
 * @description Handles all vehicle asset CRUD operations,
 * status transitions, assignment, and lifecycle tracking.
 *
 * Role permissions:
 * - GET /assets          → ALL roles
 * - POST /assets         → ADMIN only
 * - PUT /assets/:id      → ADMIN, TEAM_LEAD
 * - PATCH /assets/:id/status  → ADMIN, TEAM_LEAD
 * - POST /assets/:id/assign   → ADMIN, TEAM_LEAD
 * - GET /assets/:id/history   → ALL roles
 */

const oracledb          = require("oracledb");
const { getConnection } = require("../config/database");
const { getRedisClient } = require("../config/redis");
const logger            = require("../utils/logger");

// ── Cache TTLs ────────────────────────────────────────────────
const ASSETS_LIST_CACHE_TTL  = 300;   // 5 minutes
const ASSET_DETAIL_CACHE_TTL = 600;   // 10 minutes

// ── Valid Status Transitions ──────────────────────────────────
/**
 * Defines allowed status transitions for assets.
 * Prevents invalid state changes (e.g. RETIRED → AVAILABLE).
 *
 * Current status → allowed next statuses
 */
const VALID_TRANSITIONS = {
  AVAILABLE:        ["DEPLOYED", "MAINTENANCE", "LOANED", "OUT_OF_SERVICE"],
  DEPLOYED:         ["AVAILABLE", "MAINTENANCE", "OUT_OF_SERVICE"],
  MAINTENANCE:      ["AVAILABLE", "OUT_OF_SERVICE", "READY_FOR_HARVEST"],
  READY_FOR_HARVEST: ["AVAILABLE", "OUT_OF_SERVICE"],
  LOANED:           ["AVAILABLE", "OUT_OF_SERVICE"],
  OUT_OF_SERVICE:   ["MAINTENANCE", "AVAILABLE"],
};

// ── Get All Assets ────────────────────────────────────────────

/**
 * GET /assets
 * Returns paginated list of assets with filters.
 * Supports filtering by status, vehicle type, assigned technician.
 *
 * @query {string} status       - Filter by asset status
 * @query {string} vehicleType  - Filter by vehicle type
 * @query {number} assignedTo   - Filter by assigned user
 * @query {number} page         - Page number
 * @query {number} limit        - Results per page
 */
const getAllAssets = async (req, res) => {
  let connection;
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(
      parseInt(req.query.limit) || 20,
      100
    );
    const offset = (page - 1) * limit;
    const { status, vehicleType, assignedTo } = req.query;

    // Build cache key
    const cacheKey = `assets:list:${page}:${limit}:${status || "all"}:${vehicleType || "all"}:${assignedTo || "all"}`;
    const redis    = getRedisClient();

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    // Build dynamic WHERE clause
    const conditions = ["a.is_active = 1"];
    const binds      = { limit, offset };

    if (status) {
      conditions.push("a.status = :status");
      binds.status = status.toUpperCase();
    }
    if (vehicleType) {
      conditions.push("a.vehicle_type = :vehicleType");
      binds.vehicleType = vehicleType.toUpperCase();
    }
    if (assignedTo) {
      conditions.push("a.assigned_to = :assignedTo");
      binds.assignedTo = parseInt(assignedTo);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    connection = await getConnection();

    // Total count for pagination
    const countResult = await connection.execute(
      `SELECT COUNT(*) AS total FROM assets a ${whereClause}`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const total = countResult.rows[0].TOTAL;

    // Paginated assets with assigned user info
    const result = await connection.execute(
      `SELECT
         a.asset_id,
         a.vehicle_id,
         a.license_plate,
         a.vehicle_type,
         a.status,
         a.current_location,
         a.site_name,
         a.procured_date,
         a.procurement_cost,
         a.retired_date,
         a.notes,
         a.created_at,
         a.updated_at,
         u.user_id        AS assigned_user_id,
         u.first_name     AS assigned_first_name,
         u.last_name      AS assigned_last_name,
         u.email          AS assigned_email
       FROM assets a
       LEFT JOIN users u ON a.assigned_to = u.user_id
       ${whereClause}
       ORDER BY a.created_at DESC
       OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const response = {
      success: true,
      data: {
        assets: result.rows.map(formatAsset),
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    };

    await redis.setex(cacheKey, ASSETS_LIST_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getAllAssets error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Asset By ID ───────────────────────────────────────────

/**
 * GET /assets/:id
 * Returns a single asset with full details.
 */
const getAssetById = async (req, res) => {
  let connection;
  try {
    const { id }   = req.params;
    const cacheKey = `assets:detail:${id}`;
    const redis    = getRedisClient();

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         a.asset_id,
         a.vehicle_id,
         a.license_plate,
         a.vehicle_type,
         a.status,
         a.current_location,
         a.site_name,
         a.procured_date,
         a.procurement_cost,
         a.retired_date,
         a.retirement_reason,
         a.notes,
         a.is_active,
         a.created_at,
         a.updated_at,
         u.user_id    AS assigned_user_id,
         u.first_name AS assigned_first_name,
         u.last_name  AS assigned_last_name,
         u.email      AS assigned_email
       FROM assets a
       LEFT JOIN users u ON a.assigned_to = u.user_id
       WHERE a.asset_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    const response = {
      success: true,
      data:    formatAsset(result.rows[0]),
    };

    await redis.setex(cacheKey, ASSET_DETAIL_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getAssetById error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Create Asset ──────────────────────────────────────────────

/**
 * POST /assets
 * Creates a new vehicle asset. Admin only.
 * New assets always start as AVAILABLE.
 */
const createAsset = async (req, res) => {
  let connection;
  try {
    const {
      vehicleId,
      licensePlate,
      vehicleType,
      currentLocation,
      siteName,
      procuredDate,
      procurementCost,
      notes,
    } = req.body;

    connection = await getConnection();

    // Check for duplicate vehicle ID or license plate
    const dupCheck = await connection.execute(
      `SELECT asset_id FROM assets
       WHERE vehicle_id = :vehicleId
       OR license_plate = :licensePlate`,
      { vehicleId, licensePlate },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (dupCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Vehicle ID or license plate already exists",
      });
    }

    const result = await connection.execute(
      `INSERT INTO assets (
         vehicle_id, license_plate, vehicle_type,
         status, current_location, site_name,
         procured_date, procurement_cost,
         notes, created_by
       ) VALUES (
         :vehicleId, :licensePlate, :vehicleType,
         'AVAILABLE', :currentLocation, :siteName,
         TO_DATE(:procuredDate, 'YYYY-MM-DD'),
         :procurementCost, :notes, :createdBy
       ) RETURNING asset_id INTO :assetId`,
      {
        vehicleId,
        licensePlate,
        vehicleType:     vehicleType.toUpperCase(),
        currentLocation: currentLocation || null,
        siteName:        siteName        || null,
        procuredDate:    procuredDate    || null,
        procurementCost: procurementCost || null,
        notes:           notes           || null,
        createdBy:       req.user.userId,
        assetId:         { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    const newAssetId = result.outBinds.assetId[0];

    // Write to audit log
    await writeAuditLog({
      assetId:    newAssetId,
      action:     "CREATED",
      newStatus:  "AVAILABLE",
      changedBy:  req.user.userId,
      notes:      "Asset created",
    });

    // Invalidate assets list cache
    await invalidateAssetsListCache();

    logger.info(`Asset created: ${vehicleId} (ID: ${newAssetId})`);

    return res.status(201).json({
      success: true,
      message: "Asset created successfully",
      data:    { assetId: newAssetId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`createAsset error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Update Asset ──────────────────────────────────────────────

/**
 * PUT /assets/:id
 * Updates asset details. Admin and Team Lead.
 * Does not change status (use PATCH /status for that).
 */
const updateAsset = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const {
      currentLocation,
      siteName,
      notes,
    } = req.body;

    connection = await getConnection();

    const result = await connection.execute(
      `UPDATE assets SET
         current_location = NVL(:currentLocation, current_location),
         site_name        = NVL(:siteName,        site_name),
         notes            = NVL(:notes,            notes)
       WHERE asset_id  = :id
       AND   is_active = 1`,
      {
        currentLocation: currentLocation || null,
        siteName:        siteName        || null,
        notes:           notes           || null,
        id:              parseInt(id),
      }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    await connection.commit();
    await invalidateAssetCache(id);
    await invalidateAssetsListCache();

    return res.status(200).json({
      success: true,
      message: "Asset updated successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`updateAsset error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Update Asset Status ───────────────────────────────────────

/**
 * PATCH /assets/:id/status
 * Transitions asset to a new status.
 * Validates against allowed transitions matrix.
 * Writes to audit log on every change.
 */
const updateAssetStatus = async (req, res) => {
  let connection;
  try {
    const { id }              = req.params;
    const { status, notes }   = req.body;
    const newStatus           = status.toUpperCase();

    connection = await getConnection();

    // Get current asset status
    const current = await connection.execute(
      `SELECT asset_id, status FROM assets
       WHERE asset_id = :id AND is_active = 1`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (current.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    const currentStatus = current.rows[0].STATUS;

    // Validate the transition is allowed
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowedTransitions.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status transition: ${currentStatus} → ${newStatus}. Allowed: ${allowedTransitions.join(", ")}`,
      });
    }

    // Update status
    await connection.execute(
      `UPDATE assets
       SET status = :newStatus
       WHERE asset_id = :id`,
      { newStatus, id: parseInt(id) }
    );

    await connection.commit();

    // Write audit log
    await writeAuditLog({
      assetId:   parseInt(id),
      action:    "STATUS_CHANGE",
      oldStatus: currentStatus,
      newStatus,
      changedBy: req.user.userId,
      notes,
    });

    // Invalidate caches
    await invalidateAssetCache(id);
    await invalidateAssetsListCache();

    logger.info(
      `Asset ${id} status: ${currentStatus} → ${newStatus} by user ${req.user.userId}`
    );

    return res.status(200).json({
      success: true,
      message: `Asset status updated to ${newStatus}`,
      data: { assetId: parseInt(id), oldStatus: currentStatus, newStatus },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`updateAssetStatus error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Assign Asset ──────────────────────────────────────────────

/**
 * POST /assets/:id/assign
 * Assigns a vehicle asset to a technician.
 * Asset must be AVAILABLE to be assigned.
 * Updates asset_workflows table.
 */
const assignAsset = async (req, res) => {
  let connection;
  try {
    const { id }                     = req.params;
    const { assignedTo, ticketId, notes } = req.body;

    connection = await getConnection();

    // Verify asset exists and is available
    const assetResult = await connection.execute(
      `SELECT asset_id, status, assigned_to
       FROM assets
       WHERE asset_id = :id AND is_active = 1`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (assetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
      });
    }

    const asset = assetResult.rows[0];

    if (asset.STATUS !== "AVAILABLE") {
      return res.status(400).json({
        success: false,
        message: `Asset must be AVAILABLE to assign. Current status: ${asset.STATUS}`,
      });
    }

    const oldAssignedTo = asset.ASSIGNED_TO;

    // Update asset assignment
    await connection.execute(
      `UPDATE assets
       SET assigned_to = :assignedTo,
           status      = 'DEPLOYED'
       WHERE asset_id  = :id`,
      { assignedTo: parseInt(assignedTo), id: parseInt(id) }
    );

    // Update or create workflow record
    await connection.execute(
      `INSERT INTO asset_workflows (
         asset_id, requested_by, assigned_by,
         workflow_status, assigned_at, notes
       ) VALUES (
         :assetId, :requestedBy, :assignedBy,
         'ASSIGNED', CURRENT_TIMESTAMP, :notes
       )`,
      {
        assetId:     parseInt(id),
        requestedBy: assignedTo,
        assignedBy:  req.user.userId,
        notes:       notes || null,
      }
    );

    await connection.commit();

    // Write audit log
    await writeAuditLog({
      assetId:        parseInt(id),
      ticketId:       ticketId || null,
      action:         "ASSIGNMENT_CHANGE",
      oldStatus:      "AVAILABLE",
      newStatus:      "DEPLOYED",
      oldAssignedTo,
      newAssignedTo:  parseInt(assignedTo),
      changedBy:      req.user.userId,
      notes,
    });

    // Invalidate caches
    await invalidateAssetCache(id);
    await invalidateAssetsListCache();

    logger.info(`Asset ${id} assigned to user ${assignedTo}`);

    return res.status(200).json({
      success: true,
      message: "Asset assigned successfully",
      data: {
        assetId:    parseInt(id),
        assignedTo: parseInt(assignedTo),
        status:     "DEPLOYED",
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`assignAsset error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Asset History ─────────────────────────────────────────

/**
 * GET /assets/:id/history
 * Returns full audit log for an asset.
 * Shows all status changes, assignments, and movements.
 */
const getAssetHistory = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         l.log_id,
         l.action,
         l.old_status,
         l.new_status,
         l.notes,
         l.changed_at,
         u.first_name  || ' ' || u.last_name  AS changed_by_name,
         ou.first_name || ' ' || ou.last_name AS old_assigned_name,
         nu.first_name || ' ' || nu.last_name AS new_assigned_name
       FROM asset_audit_log l
       LEFT JOIN users u  ON l.changed_by      = u.user_id
       LEFT JOIN users ou ON l.old_assigned_to = ou.user_id
       LEFT JOIN users nu ON l.new_assigned_to = nu.user_id
       WHERE l.asset_id = :id
       ORDER BY l.changed_at DESC`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return res.status(200).json({
      success: true,
      data: {
        assetId: parseInt(id),
        history: result.rows.map((row) => ({
          logId:           row.LOG_ID,
          action:          row.ACTION,
          oldStatus:       row.OLD_STATUS,
          newStatus:       row.NEW_STATUS,
          notes:           row.NOTES,
          changedAt:       row.CHANGED_AT,
          changedByName:   row.CHANGED_BY_NAME,
          oldAssignedName: row.OLD_ASSIGNED_NAME,
          newAssignedName: row.NEW_ASSIGNED_NAME,
        })),
      },
    });
  } catch (error) {
    logger.error(`getAssetHistory error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Helpers ───────────────────────────────────────────────────

/** Formats Oracle asset row to camelCase */
const formatAsset = (row) => ({
  assetId:         row.ASSET_ID,
  vehicleId:       row.VEHICLE_ID,
  licensePlate:    row.LICENSE_PLATE,
  vehicleType:     row.VEHICLE_TYPE,
  status:          row.STATUS,
  currentLocation: row.CURRENT_LOCATION,
  siteName:        row.SITE_NAME,
  procuredDate:    row.PROCURED_DATE,
  procurementCost: row.PROCUREMENT_COST,
  retiredDate:     row.RETIRED_DATE,
  retirementReason: row.RETIREMENT_REASON,
  notes:           row.NOTES,
  isActive:        row.IS_ACTIVE === 1,
  createdAt:       row.CREATED_AT,
  updatedAt:       row.UPDATED_AT,
  assignedTo: row.ASSIGNED_USER_ID ? {
    userId:    row.ASSIGNED_USER_ID,
    firstName: row.ASSIGNED_FIRST_NAME,
    lastName:  row.ASSIGNED_LAST_NAME,
    email:     row.ASSIGNED_EMAIL,
  } : null,
});

/**
 * Writes an entry to the asset audit log.
 * Called after every status change or assignment.
 */
const writeAuditLog = async ({
  assetId,
  ticketId,
  action,
  oldStatus,
  newStatus,
  oldAssignedTo,
  newAssignedTo,
  changedBy,
  notes,
}) => {
  let connection;
  try {
    connection = await getConnection();
    await connection.execute(
      `INSERT INTO asset_audit_log (
         asset_id, ticket_id, action,
         old_status, new_status,
         old_assigned_to, new_assigned_to,
         changed_by, notes
       ) VALUES (
         :assetId, :ticketId, :action,
         :oldStatus, :newStatus,
         :oldAssignedTo, :newAssignedTo,
         :changedBy, :notes
       )`,
      {
        assetId,
        ticketId:       ticketId      || null,
        action,
        oldStatus:      oldStatus     || null,
        newStatus:      newStatus     || null,
        oldAssignedTo:  oldAssignedTo || null,
        newAssignedTo:  newAssignedTo || null,
        changedBy,
        notes:          notes         || null,
      }
    );
    await connection.commit();
  } catch (error) {
    logger.error(`writeAuditLog error: ${error.message}`);
  } finally {
    if (connection) await connection.close();
  }
};

const invalidateAssetCache = async (id) => {
  const redis = getRedisClient();
  await redis.del(`assets:detail:${id}`);
};

const invalidateAssetsListCache = async () => {
  const redis = getRedisClient();
  const keys  = await redis.keys("assets:list:*");
  if (keys.length > 0) await redis.del(...keys);
};

module.exports = {
  getAllAssets,
  getAssetById,
  createAsset,
  updateAsset,
  updateAssetStatus,
  assignAsset,
  getAssetHistory,
};
