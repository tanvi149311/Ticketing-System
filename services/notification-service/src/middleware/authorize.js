/**
 * @file middleware/authorize.js
 * @description RBAC authorization middleware.
 * Used after authenticate to check if user has
 * the required role for a route.
 *
 * Roles hierarchy:
 * ADMIN > TEAM_LEAD > TECHNICIAN
 */

const logger = require("../utils/logger");

/**
 * authorize
 * Factory function — returns middleware that checks
 * if req.user.role is in the allowed roles list.
 *
 * @param {...string} allowedRoles - Roles permitted to access the route
 *
 * @example
 * // Only admins can access this route
 * router.delete("/users/:id", authenticate, authorize("ADMIN"), deleteUser);
 *
 * @example
 * // Admins and team leads can access
 * router.post("/tickets", authenticate, authorize("ADMIN", "TEAM_LEAD"), createTicket);
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const { role, userId } = req.user;

    if (!allowedRoles.includes(role)) {
      logger.warn(
        `Unauthorized access attempt by user ${userId} with role ${role}. Required: ${allowedRoles.join(", ")}`
      );
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${allowedRoles.join(" or ")}`,
      });
    }

    next();
  };
};

module.exports = authorize;
