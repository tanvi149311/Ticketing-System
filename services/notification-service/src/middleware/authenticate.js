/**
 * @file middleware/authenticate.js
 * @description JWT authentication middleware.
 * Verifies token on every protected route before
 * the request reaches the controller.
 */

const {
  verifyAccessToken,
  isTokenBlacklisted,
} = require("../utils/tokenUtils");
const logger = require("../utils/logger");

/**
 * authenticate
 * Extracts JWT from Authorization header, verifies it,
 * checks blacklist, then attaches user to req.user.
 *
 * @example
 * router.get("/me", authenticate, getMe);
 */
const authenticate = async (req, res, next) => {
  try {
    // Extract token from "Bearer <token>"
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required",
      });
    }

    const token   = authHeader.split(" ")[1];
    const decoded = verifyAccessToken(token);

    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    // Check if token has been blacklisted (logged out)
    const blacklisted = await isTokenBlacklisted(decoded.jti);
    if (blacklisted) {
      return res.status(401).json({
        success: false,
        message: "Token has been revoked. Please login again.",
      });
    }

    // Attach decoded user to request for downstream use
    req.user = {
      userId: decoded.userId,
      role:   decoded.role,
      teamId: decoded.teamId,
      jti:    decoded.jti,
    };

    next();
  } catch (error) {
    logger.error(`Authentication error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

module.exports = authenticate;
