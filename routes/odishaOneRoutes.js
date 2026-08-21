const express = require("express");
const {
  handleLanding,
  getOdishaOneSession,
  handleCancel,
  handleSuccessRedirect,
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

module.exports = router;
