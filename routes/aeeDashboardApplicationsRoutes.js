const express = require("express");
const {
  getAEEDashboardApplicationSummary,
  getAEEDashboardApplications,
} = require("../controllers/aeeDashboardApplicationsController");

const router = express.Router();

router.get("/summary", getAEEDashboardApplicationSummary);
router.get("/applications", getAEEDashboardApplications);

module.exports = router;
