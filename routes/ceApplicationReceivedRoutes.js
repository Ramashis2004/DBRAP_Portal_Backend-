const express = require("express");
const {
  getCEApplicationReceivedApplications,
} = require("../controllers/CEApplicationReceivedController");

const router = express.Router();

// GET /api/ce-application-received/applications
// Query: userId, block_code, application_status (comma-separated)
router.get("/applications", getCEApplicationReceivedApplications);

module.exports = router;
