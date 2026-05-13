const express = require("express");
const {
  getEICApplicationReceivedApplications,
} = require("../controllers/EICApplicationReceivedController");

const router = express.Router();

// GET /api/eic-application-received/applications
// Query: userId, block_code, application_status (comma-separated)
router.get("/applications", getEICApplicationReceivedApplications);

module.exports = router;
