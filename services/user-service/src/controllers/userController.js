/**
 * @file controllers/userController.js
 * @description Handles all user CRUD operations.
 * All routes are protected by JWT + RBAC middleware.
 *
 * Role permissions:
 * - GET /users        → ADMIN only
 * - POST /users       → ADMIN only
 * - GET /users/:id    → ADMIN, TEAM_LEAD
 * - PUT /users/:id    → ADMIN only
 * - DELETE /users/:id → ADMIN only
 */

const bcrypt         = require("bcryptjs");
const oracledb       = require("oracledb");
const { getConnection } = require("../config/database");
const { getRedisClient } = require("../config/redis");
const logger         = require("../utils/logger");

// ── Constants ─────────────────────────────────────────────────
const BCRYPT_SALT_ROUNDS  = 12;
const USER_CACHE_TTL      = 3600; // 1 hour
const USERS_LIST_CACHE_TTL = 300; // 5 minutes

// ── Get All Users ─────────────────────────────────────────────

/**
 * GET /users
 * Returns paginated list of all users.
 * Supports filtering by role, team, and active status.
 * Results cached in Redis for 5 minutes.
 *
 * @query {number} page     - Page number (default: 1)
 * @query {number} limit    - Results per page (default: 20)
 * @query {string} role     - Filter by role
 * @query {number} teamId   - Filter by team
 * @query {number} isActive - Filter by active status
 */
const getAllUsers = async (req, res) => {
  let connection;
  try {
    const page     = parseInt(req.query.page)  || 1;
    const limit    = Math.min(
      parseInt(req.query.limit) || 20,
      parseInt(process.env.MAX_PAGE_SIZE) || 100
    );
    const offset   = (page - 1) * limit;
    const { role, teamId, isActive } = req.query;

    // Build cache key from query params
    const cacheKey = `users:list:${page}:${limit}:${role || "all"}:${teamId || "all"}:${isActive ?? "all"}`;
    const redis    = getRedisClient();

    // Check Redis cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    // Build dynamic WHERE clause
    const conditions = [];
    const binds      = { limit, offset };

    if (role) {
      conditions.push("u.role = :role");
      binds.role = role;
    }
    if (teamId) {
      conditions.push("u.team_id = :teamId");
      binds.teamId = parseInt(teamId);
    }
    if (isActive !== undefined) {
      conditions.push("u.is_active = :isActive");
      binds.isActive = parseInt(isActive);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    connection = await getConnection();

    // Get total count for pagination
    const countResult = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM users u ${whereClause}`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const total = countResult.rows[0].TOTAL;

    // Get paginated users
    const result = await connection.execute(
      `SELECT
         u.user_id,
         u.username,
         u.email,
         u.first_name,
         u.last_name,
         u.role,
         u.team_id,
         t.team_name,
         u.is_active,
         u.last_login,
         u.created_at
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.team_id
       ${whereClause}
       ORDER BY u.created_at DESC
       OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const response = {
      success: true,
      data: {
        users: result.rows.map(formatUser),
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    };

    // Cache result in Redis
    await redis.setex(cacheKey, USERS_LIST_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getAllUsers error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get User By ID ────────────────────────────────────────────

/**
 * GET /users/:id
 * Returns a single user by ID.
 * Result cached in Redis for 1 hour.
 */
const getUserById = async (req, res) => {
  let connection;
  try {
    const { id }   = req.params;
    const cacheKey = `users:detail:${id}`;
    const redis    = getRedisClient();

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         u.user_id,
         u.username,
         u.email,
         u.first_name,
         u.last_name,
         u.role,
         u.team_id,
         t.team_name,
         u.is_active,
         u.last_login,
         u.created_at,
         u.updated_at
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.team_id
       WHERE u.user_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const response = {
      success: true,
      data:    formatUser(result.rows[0]),
    };

    // Cache result
    await redis.setex(cacheKey, USER_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getUserById error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Create User ───────────────────────────────────────────────

/**
 * POST /users
 * Creates a new user. Admin only.
 * Hashes password with bcrypt before storing.
 */
const createUser = async (req, res) => {
  let connection;
  try {
    const {
      username,
      email,
      password,
      firstName,
      lastName,
      role,
      teamId,
    } = req.body;

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    connection = await getConnection();

    // Check for duplicate email or username
    const dupCheck = await connection.execute(
      `SELECT user_id FROM users
       WHERE email = :email OR username = :username`,
      { email, username },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (dupCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email or username already exists",
      });
    }

    // Insert new user
    const result = await connection.execute(
      `INSERT INTO users (
         username, email, password_hash,
         first_name, last_name, role, team_id
       ) VALUES (
         :username, :email, :passwordHash,
         :firstName, :lastName, :role, :teamId
       ) RETURNING user_id INTO :userId`,
      {
        username,
        email,
        passwordHash,
        firstName,
        lastName,
        role:     role     || "TECHNICIAN",
        teamId:   teamId   || null,
        userId:   { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    // Invalidate users list cache
    await invalidateUsersCache();

    const newUserId = result.outBinds.userId[0];
    logger.info(`User created: ${email} (ID: ${newUserId}) by admin ${req.user.userId}`);

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      data:    { userId: newUserId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`createUser error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Update User ───────────────────────────────────────────────

/**
 * PUT /users/:id
 * Updates user details. Admin only.
 * Invalidates Redis cache on update.
 */
const updateUser = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const {
      firstName,
      lastName,
      role,
      teamId,
      isActive,
    } = req.body;

    connection = await getConnection();

    // Verify user exists
    const existing = await connection.execute(
      `SELECT user_id FROM users WHERE user_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await connection.execute(
      `UPDATE users SET
         first_name = NVL(:firstName, first_name),
         last_name  = NVL(:lastName,  last_name),
         role       = NVL(:role,      role),
         team_id    = NVL(:teamId,    team_id),
         is_active  = NVL(:isActive,  is_active)
       WHERE user_id = :id`,
      {
        firstName: firstName || null,
        lastName:  lastName  || null,
        role:      role      || null,
        teamId:    teamId    || null,
        isActive:  isActive  !== undefined ? isActive : null,
        id:        parseInt(id),
      }
    );

    await connection.commit();

    // Invalidate caches
    await invalidateUserCache(id);
    await invalidateUsersCache();

    logger.info(`User ${id} updated by admin ${req.user.userId}`);

    return res.status(200).json({
      success: true,
      message: "User updated successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`updateUser error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Delete User ───────────────────────────────────────────────

/**
 * DELETE /users/:id
 * Soft deletes a user by setting is_active = 0.
 * Hard delete is never done to preserve audit trails.
 */
const deleteUser = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    // Prevent self-deletion
    if (parseInt(id) === req.user.userId) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      });
    }

    connection = await getConnection();

    const result = await connection.execute(
      `UPDATE users
       SET is_active = 0
       WHERE user_id = :id`,
      { id: parseInt(id) }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await connection.commit();

    // Invalidate caches
    await invalidateUserCache(id);
    await invalidateUsersCache();

    logger.info(`User ${id} deactivated by admin ${req.user.userId}`);

    return res.status(200).json({
      success: true,
      message: "User deactivated successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`deleteUser error: ${error.message}`);
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
 * Formats Oracle row (uppercase keys) to camelCase response.
 * Keeps password_hash out of responses.
 */
const formatUser = (row) => ({
  userId:    row.USER_ID,
  username:  row.USERNAME,
  email:     row.EMAIL,
  firstName: row.FIRST_NAME,
  lastName:  row.LAST_NAME,
  role:      row.ROLE,
  teamId:    row.TEAM_ID,
  teamName:  row.TEAM_NAME,
  isActive:  row.IS_ACTIVE === 1,
  lastLogin: row.LAST_LOGIN,
  createdAt: row.CREATED_AT,
  updatedAt: row.UPDATED_AT,
});

/** Invalidates a single user's Redis cache */
const invalidateUserCache = async (userId) => {
  const redis = getRedisClient();
  await redis.del(`users:detail:${userId}`);
};

/** Invalidates the users list cache (all pages) */
const invalidateUsersCache = async () => {
  const redis = getRedisClient();
  const keys  = await redis.keys("users:list:*");
  if (keys.length > 0) await redis.del(...keys);
};

module.exports = {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
};
