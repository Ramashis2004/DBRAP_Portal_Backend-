const express = require("express");
const {
  getCEDashboardApplicationSummary,
  getCEDashboardCircleReport,
  getCEDashboardDivisionReport,
  getCEDashboardBlockReport,
  getCEDashboardBlockApplications,
  getCEDashboardPanchayatReport
} = require("../controllers/ceDashboardApplicationsController");

const router = express.Router();

router.get("/summary", getCEDashboardApplicationSummary);
router.get("/circles", getCEDashboardCircleReport);
router.get("/divisions", getCEDashboardDivisionReport);
router.get("/blocks", getCEDashboardBlockReport);
router.get("/applications", getCEDashboardBlockApplications);
router.get("/panchayats", getCEDashboardPanchayatReport);
module.exports = router;
