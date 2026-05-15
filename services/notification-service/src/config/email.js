/**
 * @file config/email.js
 * @description Nodemailer transporter configuration.
 * Supports Gmail SMTP in development and
 * any SMTP provider in production.
 *
 * For Gmail: use App Password, not your account password.
 * Generate at: Google Account → Security → App Passwords
 */

const nodemailer = require("nodemailer");
const logger     = require("../utils/logger");

let transporter;

/**
 * Initializes the email transporter.
 * Verifies SMTP connection on startup.
 */
const initializeEmail = async () => {
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || "smtp.gmail.com",
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    // Connection pool for multiple emails
    pool:           true,
    maxConnections: 5,
    maxMessages:    100,
  });

  try {
    await transporter.verify();
    logger.info("✅ Email transporter ready");
  } catch (error) {
    // Don't crash the service if email isn't configured
    logger.warn(`⚠️ Email transporter not verified: ${error.message}`);
  }
};

/**
 * Returns the active email transporter.
 */
const getTransporter = () => {
  if (!transporter) {
    throw new Error("Email not initialized. Call initializeEmail() first.");
  }
  return transporter;
};

module.exports = { initializeEmail, getTransporter };