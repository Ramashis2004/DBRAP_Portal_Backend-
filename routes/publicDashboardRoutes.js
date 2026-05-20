const express = require("express");
const { getPublicDashboardSummary } = require("../controllers/publicDashboardController");

const router = express.Router();

router.get("/summary", getPublicDashboardSummary);

module.exports = router;
