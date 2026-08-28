const express = require("express");
const {
  handleLanding,
  getOdishaOneSession,
  handleCancel,
  handleSuccessRedirect,
  handleRequiredCorrectionRedirect,
  getAuditLogs,
} = require("../controllers/odishaOneController");

const router = express.Router();

// API 1: Receive encrypted payload & landing redirect from Odisha One
router.post("/landing", handleLanding);
router.get("/landing", handleLanding);

// Retrieve handoff details for frontend session setup
router.get("/session", getOdishaOneSession);

// API 3: Cancel / Return to Odisha One
router.post("/cancel", handleCancel);

// API 4: Success API after registration
router.post("/success", handleSuccessRedirect);

// API 12: Required Correction Redirect — after PAYMENT_RECEIPT_UPLOADED
router.post("/required-correction", handleRequiredCorrectionRedirect);

// Audit log inspection API
router.get("/logs", getAuditLogs);

module.exports = router;

