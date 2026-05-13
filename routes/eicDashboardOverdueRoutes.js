const express = require("express");
const {
  getEICDashboardOverdueSummary,
  getEICDashboardOverdueByDivision,
  getEICDashboardOverdueApplicationsByDivision,
  getEICDashboardOverdueApplicationHistory,
} = require("../controllers/eicDashboardOverdueController");

const router = express.Router();

router.get("/overdue-summary", getEICDashboardOverdueSummary);
router.get("/overdue-by-division", getEICDashboardOverdueByDivision);
router.get("/overdue-applications-by-division", getEICDashboardOverdueApplicationsByDivision);
router.get("/overdue-application-history", getEICDashboardOverdueApplicationHistory);

module.exports = router;
