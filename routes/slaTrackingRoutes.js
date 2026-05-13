const express = require("express");
const router = express.Router();

const {
  getSlaTrackingByApplication,
} = require("../controllers/slaTrackingController");

router.get("/applications/:applicationId", getSlaTrackingByApplication);

module.exports = router;
