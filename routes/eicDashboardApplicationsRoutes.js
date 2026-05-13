const express = require("express");
const {
  getEICDashboardApplicationSummary,
  getEICDashboardCircleReport,
  getEICDashboardDivisionReport,
  getEICDashboardBlockReport,
  getEICDashboardBlockApplications,
} = require("../controllers/eicDashboardApplicationsController");

const router = express.Router();

router.get("/summary", getEICDashboardApplicationSummary);
router.get("/circles", getEICDashboardCircleReport);
router.get("/divisions", getEICDashboardDivisionReport);
router.get("/blocks", getEICDashboardBlockReport);
router.get("/applications", getEICDashboardBlockApplications);

module.exports = router;
