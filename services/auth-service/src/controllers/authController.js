/**
 * @file controllers/authController.js
 * @description Handles login, logout, token refresh, and
 * current user retrieval.
 *
 * All DB queries use parameterized statements to
 * prevent SQL injection.
 */

const bcrypt  = require("bcryptjs");
const { getConnection } = require("../config/database");
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  storeSession,
  blacklistToken,
  isTokenBlacklisted,
  removeSession,
} = require("../utils/tokenUtils");
const logger = require("../utils/logger");

// ── Login ─────────────────────────────────────────────────────

/**
 * POST /auth/login
 * Authenticates user with email + password.
 * Returns access token + refresh token on success.
 *
 * @param {Request}  req - { email, password }
 * @param {Response} res
 */
const login = async (req, res) => {
  const { email, password } = req.body;
  let connection;

  try {
    connection = await getConnection();

    // Fetch user by email — parameterized to prevent SQL injection
    const result = await connection.execute(
      `SELECT
         u.user_id,
         u.username,
         u.email,
         u.password_hash,
         u.first_name,
         u.last_name,
         u.role,
         u.team_id,
         u.is_active
       FROM users u
       WHERE u.email = :email`,
      { email },
      { outFormat: require("oracledb").OUT_FORMAT_OBJECT }
    );

    const user = result.rows[0];

    // User not found
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Account disabled
    if (user.IS_ACTIVE === 0) {
      return res.status(403).json({
        success: false,
        message: "Account has been deactivated. Contact your admin.",
      });
    }

    // Verify password against bcrypt hash
    const isPasswordValid = await bcrypt.compare(
      password,
      user.PASSWORD_HASH
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Build token payload
    const tokenPayload = {
      userId: user.USER_ID,
      role:   user.ROLE,
      teamId: user.TEAM_ID,
    };

    // Generate tokens
    const accessToken  = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store session in Redis
    await storeSession(user.USER_ID, accessToken);

    // Update last login timestamp
    await connection.execute(
      `UPDATE users
       SET last_login = CURRENT_TIMESTAMP
       WHERE user_id = :userId`,
      { userId: user.USER_ID }
    );
    await connection.commit();

    logger.info(`User ${user.EMAIL} logged in successfully`);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        user: {
          userId:    user.USER_ID,
          username:  user.USERNAME,
          email:     user.EMAIL,
          firstName: user.FIRST_NAME,
          lastName:  user.LAST_NAME,
          role:      user.ROLE,
          teamId:    user.TEAM_ID,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    // Always release connection back to pool
    if (connection) await connection.close();
  }
};

// ── Logout ────────────────────────────────────────────────────

/**
 * POST /auth/logout
 * Blacklists the current access token and removes session.
 * Even if JWT hasn't expired, it will be rejected after logout.
 *
 * @param {Request}  req - Requires valid JWT in Authorization header
 * @param {Response} res
 */
const logout = async (req, res) => {
  try {
    const { userId, jti } = req.user;
    const token = req.headers.authorization?.split(" ")[1];

    // Blacklist token in Redis
    await blacklistToken(token, jti);

    // Remove session from Redis
    await removeSession(userId);

    logger.info(`User ${userId} logged out`);

    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    logger.error(`Logout error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ── Refresh Token ─────────────────────────────────────────────

/**
 * POST /auth/refresh-token
 * Issues a new access token using a valid refresh token.
 * Implements token rotation — old refresh token is blacklisted.
 *
 * @param {Request}  req - { refreshToken }
 * @param {Response} res
 */
const refreshToken = async (req, res) => {
  const { refreshToken: token } = req.body;
  let connection;

  try {
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Refresh token is required",
      });
    }

    // Verify refresh token
    const decoded = verifyRefreshToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired refresh token",
      });
    }

    // Check if refresh token is blacklisted
    const blacklisted = await isTokenBlacklisted(decoded.jti);
    if (blacklisted) {
      return res.status(401).json({
        success: false,
        message: "Token has been revoked",
      });
    }

    // Fetch fresh user data from DB
    connection = await getConnection();
    const result = await connection.execute(
      `SELECT user_id, role, team_id, is_active
       FROM users
       WHERE user_id = :userId`,
      { userId: decoded.userId },
      { outFormat: require("oracledb").OUT_FORMAT_OBJECT }
    );

    const user = result.rows[0];

    if (!user || user.IS_ACTIVE === 0) {
      return res.status(401).json({
        success: false,
        message: "User not found or deactivated",
      });
    }

    // Generate new tokens (token rotation)
    const tokenPayload = {
      userId: user.USER_ID,
      role:   user.ROLE,
      teamId: user.TEAM_ID,
    };

    const newAccessToken  = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    // Store new session, blacklist old refresh token
    await storeSession(user.USER_ID, newAccessToken);
    await blacklistToken(token, decoded.jti);

    return res.status(200).json({
      success: true,
      data: {
        accessToken:  newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    logger.error(`Refresh token error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

// ── Get Current User ──────────────────────────────────────────

/**
 * GET /auth/me
 * Returns the currently authenticated user's profile.
 *
 * @param {Request}  req - Requires valid JWT
 * @param {Response} res
 */
const getMe = async (req, res) => {
  let connection;
  try {
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
         u.last_login,
         u.created_at
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.team_id
       WHERE u.user_id = :userId`,
      { userId: req.user.userId },
      { outFormat: require("oracledb").OUT_FORMAT_OBJECT }
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        userId:    user.USER_ID,
        username:  user.USERNAME,
        email:     user.EMAIL,
        firstName: user.FIRST_NAME,
        lastName:  user.LAST_NAME,
        role:      user.ROLE,
        teamId:    user.TEAM_ID,
        teamName:  user.TEAM_NAME,
        lastLogin: user.LAST_LOGIN,
        createdAt: user.CREATED_AT,
      },
    });
  } catch (error) {
    logger.error(`GetMe error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    if (connection) await connection.close();
  }
};

module.exports = { login, logout, refreshToken, getMe };
