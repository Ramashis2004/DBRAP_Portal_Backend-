const express = require("express");
const {
  getSEDashboardApplicationSummary,
  getSEDashboardApplications,
} = require("../controllers/seDashboardApplicationsController");

const router = express.Router();

router.get("/summary", getSEDashboardApplicationSummary);
router.get("/applications", getSEDashboardApplications);

module.exports = router;
