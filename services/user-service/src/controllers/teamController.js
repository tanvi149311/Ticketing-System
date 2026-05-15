/**
 * @file controllers/teamController.js
 * @description Handles team CRUD and member management.
 *
 * Role permissions:
 * - GET /teams           → ALL roles
 * - POST /teams          → ADMIN only
 * - PUT /teams/:id       → ADMIN only
 * - GET /teams/:id/members → ADMIN, TEAM_LEAD
 */

const oracledb          = require("oracledb");
const { getConnection } = require("../config/database");
const { getRedisClient } = require("../config/redis");
const logger            = require("../utils/logger");

// ── Cache TTLs ────────────────────────────────────────────────
const TEAMS_CACHE_TTL  = 300;  // 5 minutes
const TEAM_CACHE_TTL   = 300;  // 5 minutes

// ── Get All Teams ─────────────────────────────────────────────

/**
 * GET /teams
 * Returns all active teams with member count.
 * Accessible by all authenticated roles.
 */
const getAllTeams = async (req, res) => {
  let connection;
  try {
    const cacheKey = "teams:list";
    const redis    = getRedisClient();

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         t.team_id,
         t.team_name,
         t.description,
         t.is_active,
         t.created_at,
         u.first_name || ' ' || u.last_name AS created_by_name,
         (SELECT COUNT(*)
          FROM users m
          WHERE m.team_id = t.team_id
          AND   m.is_active = 1) AS member_count
       FROM teams t
       LEFT JOIN users u ON t.created_by = u.user_id
       WHERE t.is_active = 1
       ORDER BY t.team_name ASC`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const response = {
      success: true,
      data:    result.rows.map(formatTeam),
    };

    // Cache result
    await redis.setex(cacheKey, TEAMS_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getAllTeams error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Team By ID ────────────────────────────────────────────

/**
 * GET /teams/:id
 * Returns a single team with full details.
 */
const getTeamById = async (req, res) => {
  let connection;
  try {
    const { id }   = req.params;
    const cacheKey = `teams:detail:${id}`;
    const redis    = getRedisClient();

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    connection = await getConnection();

    const result = await connection.execute(
      `SELECT
         t.team_id,
         t.team_name,
         t.description,
         t.is_active,
         t.created_at,
         t.updated_at,
         u.first_name || ' ' || u.last_name AS created_by_name
       FROM teams t
       LEFT JOIN users u ON t.created_by = u.user_id
       WHERE t.team_id = :id`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    const response = {
      success: true,
      data:    formatTeam(result.rows[0]),
    };

    await redis.setex(cacheKey, TEAM_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getTeamById error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Create Team ───────────────────────────────────────────────

/**
 * POST /teams
 * Creates a new team. Admin only.
 */
const createTeam = async (req, res) => {
  let connection;
  try {
    const { teamName, description } = req.body;

    connection = await getConnection();

    // Check for duplicate team name
    const dupCheck = await connection.execute(
      `SELECT team_id FROM teams WHERE team_name = :teamName`,
      { teamName },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (dupCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Team name already exists",
      });
    }

    const result = await connection.execute(
      `INSERT INTO teams (team_name, description, created_by)
       VALUES (:teamName, :description, :createdBy)
       RETURNING team_id INTO :teamId`,
      {
        teamName,
        description: description || null,
        createdBy:   req.user.userId,
        teamId:      { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );

    await connection.commit();

    // Invalidate teams list cache
    await invalidateTeamsCache();

    const newTeamId = result.outBinds.teamId[0];
    logger.info(`Team created: ${teamName} (ID: ${newTeamId})`);

    return res.status(201).json({
      success: true,
      message: "Team created successfully",
      data:    { teamId: newTeamId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`createTeam error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Update Team ───────────────────────────────────────────────

/**
 * PUT /teams/:id
 * Updates team details. Admin only.
 */
const updateTeam = async (req, res) => {
  let connection;
  try {
    const { id }                    = req.params;
    const { teamName, description } = req.body;

    connection = await getConnection();

    const result = await connection.execute(
      `UPDATE teams SET
         team_name   = NVL(:teamName,   team_name),
         description = NVL(:description, description)
       WHERE team_id = :id`,
      {
        teamName:    teamName    || null,
        description: description || null,
        id:          parseInt(id),
      }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    await connection.commit();

    // Invalidate caches
    await invalidateTeamCache(id);
    await invalidateTeamsCache();

    return res.status(200).json({
      success: true,
      message: "Team updated successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`updateTeam error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Team Members ──────────────────────────────────────────

/**
 * GET /teams/:id/members
 * Returns all active members of a team.
 * Accessible by ADMIN and TEAM_LEAD.
 */
const getTeamMembers = async (req, res) => {
  let connection;
  try {
    const { id }   = req.params;
    const cacheKey = `teams:members:${id}`;
    const redis    = getRedisClient();

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
         u.last_login,
         u.created_at
       FROM users u
       WHERE u.team_id  = :id
       AND   u.is_active = 1
       ORDER BY u.role ASC, u.first_name ASC`,
      { id: parseInt(id) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const response = {
      success: true,
      data: {
        teamId:  parseInt(id),
        members: result.rows.map((row) => ({
          userId:    row.USER_ID,
          username:  row.USERNAME,
          email:     row.EMAIL,
          firstName: row.FIRST_NAME,
          lastName:  row.LAST_NAME,
          role:      row.ROLE,
          lastLogin: row.LAST_LOGIN,
          createdAt: row.CREATED_AT,
        })),
      },
    };

    await redis.setex(cacheKey, TEAMS_CACHE_TTL, JSON.stringify(response));

    return res.status(200).json(response);
  } catch (error) {
    logger.error(`getTeamMembers error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Helpers ───────────────────────────────────────────────────

/** Formats Oracle team row to camelCase */
const formatTeam = (row) => ({
  teamId:        row.TEAM_ID,
  teamName:      row.TEAM_NAME,
  description:   row.DESCRIPTION,
  isActive:      row.IS_ACTIVE === 1,
  memberCount:   row.MEMBER_COUNT,
  createdByName: row.CREATED_BY_NAME,
  createdAt:     row.CREATED_AT,
  updatedAt:     row.UPDATED_AT,
});

const invalidateTeamCache  = async (id) => {
  const redis = getRedisClient();
  await redis.del(`teams:detail:${id}`);
  await redis.del(`teams:members:${id}`);
};

const invalidateTeamsCache = async () => {
  const redis = getRedisClient();
  await redis.del("teams:list");
};

module.exports = {
  getAllTeams,
  getTeamById,
  createTeam,
  updateTeam,
  getTeamMembers,
};
