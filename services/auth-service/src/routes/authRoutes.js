/**
 * @file routes/authRoutes.js
 * @description Auth service route definitions.
 * Input validation runs before controllers using
 * express-validator.
 */

const express   = require("express");
const { body }  = require("express-validator");
const router    = express.Router();

const {
  login,
  logout,
  refreshToken,
  getMe,
}                   = require("../controllers/authController");
const authenticate  = require("../middleware/authenticate");

// ── Validation Rules ──────────────────────────────────────────

/** Validates login request body */
const loginValidation = [
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Valid email is required"),
  body("password")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters"),
];

/** Validates refresh token request body */
const refreshValidation = [
  body("refreshToken")
    .notEmpty()
    .withMessage("Refresh token is required"),
];

// ── Validation Error Handler ──────────────────────────────────

const { validationResult } = require("express-validator");

/**
 * Middleware that checks validation results.
 * Returns 400 with error details if validation fails.
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors:  errors.array().map((e) => ({
        field:   e.path,
        message: e.msg,
      })),
    });
  }
  next();
};

// ── Routes ────────────────────────────────────────────────────

/**
 * POST /auth/login
 * Public — no authentication required
 */
router.post(
  "/login",
  loginValidation,
  handleValidationErrors,
  login
);

/**
 * POST /auth/logout
 * Protected — requires valid JWT
 */
router.post("/logout", authenticate, logout);

/**
 * POST /auth/refresh-token
 * Public — uses refresh token to get new access token
 */
router.post(
  "/refresh-token",
  refreshValidation,
  handleValidationErrors,
  refreshToken
);

/**
 * GET /auth/me
 * Protected — returns current user profile
 */
router.get("/me", authenticate, getMe);

module.exports = router;
