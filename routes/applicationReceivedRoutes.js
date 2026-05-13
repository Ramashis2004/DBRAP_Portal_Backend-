const express = require("express");
const { getApplicationReceivedApplications } = require("../controllers/applicationReceivedController");

const router = express.Router();

router.get("/applications", getApplicationReceivedApplications);

module.exports = router;
