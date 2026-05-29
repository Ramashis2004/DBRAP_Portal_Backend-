// routes/seDashboardStatusCountRoutes.js
const express = require("express");
const router  = express.Router();
const { getSEStatusCounts } = require("../controllers/seDashboardStatusCountController");

router.get("/status-counts", getSEStatusCounts);

module.exports = router;
