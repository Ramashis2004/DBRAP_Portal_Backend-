const express = require("express");
const router  = express.Router();
const { getAEEStatusCounts } = require("../controllers/aeeStatusCountController");

// GET /api/aee-dashboard-applications/status-counts?userId=<id>
router.get("/status-counts", getAEEStatusCounts);

module.exports = router;