const express = require("express");
const {
  getPendingForwardToJE,
  getPendingApproval,
} = require("../controllers/pendingApplicationsController");

const router = express.Router();

// GET /api/pending-applications/forward-to-je?userId=xxx
router.get("/forward-to-je", getPendingForwardToJE);

// GET /api/pending-applications/approval?userId=xxx
router.get("/approval", getPendingApproval);

module.exports = router;