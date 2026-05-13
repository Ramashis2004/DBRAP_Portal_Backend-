const express = require("express");
const router = express.Router();

const {
  getCEDashboardOverdueSummary,
  getCEDashboardOverdueByDivision,
  getCEDashboardOverdueApplicationsByDivision,
  getCEDashboardOverdueApplicationHistory,
} = require("../controllers/ceDashboardOverdueController");

router.get("/overdue-summary", getCEDashboardOverdueSummary);
router.get("/overdue-by-division", getCEDashboardOverdueByDivision);
router.get("/overdue-applications-by-division", getCEDashboardOverdueApplicationsByDivision);
router.get("/overdue-application-history", getCEDashboardOverdueApplicationHistory);

module.exports = router;
