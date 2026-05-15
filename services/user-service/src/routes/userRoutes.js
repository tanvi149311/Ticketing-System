/**
 * @file routes/userRoutes.js
 * @description User management routes with validation
 * and role-based access control.
 */

const express    = require("express");
const { body }   = require("express-validator");
const router     = express.Router();

const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
} = require("../controllers/userController");

const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

// ── Validation ────────────────────────────────────────────────

const createUserValidation = [
  body("username")
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage("Username must be 3-50 characters"),
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Valid email is required"),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
  body("firstName")
    .trim()
    .notEmpty()
    .withMessage("First name is required"),
  body("lastName")
    .trim()
    .notEmpty()
    .withMessage("Last name is required"),
  body("role")
    .optional()
    .isIn(["ADMIN", "TEAM_LEAD", "TECHNICIAN"])
    .withMessage("Role must be ADMIN, TEAM_LEAD, or TECHNICIAN"),
];

const updateUserValidation = [
  body("role")
    .optional()
    .isIn(["ADMIN", "TEAM_LEAD", "TECHNICIAN"])
    .withMessage("Invalid role"),
  body("isActive")
    .optional()
    .isIn([0, 1])
    .withMessage("isActive must be 0 or 1"),
];

// ── Validation Handler ────────────────────────────────────────

const { validationResult } = require("express-validator");

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

router.get(
  "/",
  authenticate,
  authorize("ADMIN"),
  getAllUsers
);

router.get(
  "/:id",
  authenticate,
  authorize("ADMIN", "TEAM_LEAD"),
  getUserById
);

router.post(
  "/",
  authenticate,
  authorize("ADMIN"),
  createUserValidation,
  handleValidationErrors,
  createUser
);

router.put(
  "/:id",
  authenticate,
  authorize("ADMIN"),
  updateUserValidation,
  handleValidationErrors,
  updateUser
);

router.delete(
  "/:id",
  authenticate,
  authorize("ADMIN"),
  deleteUser
);

module.exports = router;
