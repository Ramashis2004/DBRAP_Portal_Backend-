const express = require("express");
const router = express.Router();
const {
  getLoginHistoryByUser,
  getApplicationHistoryByApplication,
} = require("../controllers/historyController");

// GET /api/history/login/:userId - Get login history for a user
router.get("/login/:userId", getLoginHistoryByUser);

// GET /api/history/application/:applicationId - Get application history for an application
router.get("/application/:applicationId", getApplicationHistoryByApplication);

module.exports = router;
