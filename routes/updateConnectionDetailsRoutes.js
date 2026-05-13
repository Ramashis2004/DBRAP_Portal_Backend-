// routes/updateConnectionDetailsRoutes.js
// Mount this in your main app: app.use("/api/officer", updateConnectionDetailsRoutes);

const express = require("express");
const router = express.Router();
const {
  getApplicationsForConnectionUpdate,
  updateConnectionDetails,
} = require("../controllers/updateConnectionDetailsController"); // adjust path

// GET  /api/officer/connection-details/applications?blockCode=XXX
router.get("/connection-details/applications", getApplicationsForConnectionUpdate);

// POST /api/officer/connection-details/update
router.post("/connection-details/update", updateConnectionDetails);

module.exports = router;
