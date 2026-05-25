// pendingPieChart.routes.js
// Mount in your main app:
//   const cePendingRoutes  = require("./routes/pendingPieChart.routes").cePendingRouter;
//   const eicPendingRoutes = require("./routes/pendingPieChart.routes").eicPendingRouter;
//   app.use("/api/ce-pending",  cePendingRoutes);
//   app.use("/api/eic-pending", eicPendingRoutes);

const express = require("express");
const {
  getCEPendingSummary,
  getCEPendingByDivision,
  getCEPendingApplicationsByDivision,
  getCEPendingApplicationHistory,
  getEICPendingSummary,
  getEICPendingByDivision,
  getEICPendingApplicationsByDivision,
  getEICPendingApplicationHistory,
} = require("../controllers/pendingPieChartController");

// ── CE router ─────────────────────────────────────────────────────────────────
const cePendingRouter = express.Router();

cePendingRouter.get("/summary",                  getCEPendingSummary);
cePendingRouter.get("/by-division",              getCEPendingByDivision);
cePendingRouter.get("/applications-by-division", getCEPendingApplicationsByDivision);
cePendingRouter.get("/application-history",      getCEPendingApplicationHistory);

// ── EIC router ────────────────────────────────────────────────────────────────
const eicPendingRouter = express.Router();

eicPendingRouter.get("/summary",                  getEICPendingSummary);
eicPendingRouter.get("/by-division",              getEICPendingByDivision);
eicPendingRouter.get("/applications-by-division", getEICPendingApplicationsByDivision);
eicPendingRouter.get("/application-history",      getEICPendingApplicationHistory);

module.exports = { cePendingRouter, eicPendingRouter };
