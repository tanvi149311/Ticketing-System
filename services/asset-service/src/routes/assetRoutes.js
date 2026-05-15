/**
 * @file routes/assetRoutes.js
 * @description Asset management routes with validation
 * and role-based access control.
 */

const express   = require("express");
const { body }  = require("express-validator");
const router    = express.Router();

const {
  getAllAssets,
  getAssetById,
  createAsset,
  updateAsset,
  updateAssetStatus,
  assignAsset,
  getAssetHistory,
} = require("../controllers/assetController");

const authenticate = require("../middleware/authenticate");
const authorize    = require("../middleware/authorize");

// ── Validation ────────────────────────────────────────────────

const createAssetValidation = [
  body("vehicleId")
    .trim()
    .notEmpty()
    .withMessage("Vehicle ID is required"),
  body("licensePlate")
    .trim()
    .notEmpty()
    .withMessage("License plate is required"),
  body("vehicleType")
    .isIn(["VAN", "TRUCK", "CAR", "MOTORCYCLE", "OTHER"])
    .withMessage("Invalid vehicle type"),
  body("procurementCost")
    .optional()
    .isNumeric()
    .withMessage("Procurement cost must be a number"),
];

const statusValidation = [
  body("status")
    .isIn([
      "AVAILABLE",
      "DEPLOYED",
      "MAINTENANCE",
      "READY_FOR_HARVEST",
      "LOANED",
      "OUT_OF_SERVICE",
    ])
    .withMessage("Invalid status value"),
];

const assignValidation = [
  body("assignedTo")
    .isInt({ min: 1 })
    .withMessage("Valid user ID is required"),
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

// All roles can view assets
router.get("/",    authenticate, getAllAssets);
router.get("/:id", authenticate, getAssetById);

// All roles can view asset history
router.get("/:id/history", authenticate, getAssetHistory);

// Admin only — create assets
router.post(
  "/",
  authenticate,
  authorize("ADMIN"),
  createAssetValidation,
  handleValidationErrors,
  createAsset
);

// Admin + Team Lead — update details
router.put(
  "/:id",
  authenticate,
  authorize("ADMIN", "TEAM_LEAD"),
  updateAsset
);

// Admin + Team Lead — change status
router.patch(
  "/:id/status",
  authenticate,
  authorize("ADMIN", "TEAM_LEAD"),
  statusValidation,
  handleValidationErrors,
  updateAssetStatus
);

// Admin + Team Lead — assign asset
router.post(
  "/:id/assign",
  authenticate,
  authorize("ADMIN", "TEAM_LEAD"),
  assignValidation,
  handleValidationErrors,
  assignAsset
);

module.exports = router;
