const express = require("express");
const {
  preparePayload,
  decryptPayload,
  handleApi1Landing,
  handleApi2VerifyRequest,
  handleApi3Cancel,
  handleApi4Success,
  handleApi9PushApplicationStatus,
} = require("../controllers/tpiController");

const router = express.Router();

// Helper endpoints for Postman testing
router.post("/helper/prepare-payload", preparePayload);
router.post("/helper/decrypt-payload", decryptPayload);

// API 1: Push API to push encrypted data (Landing)
router.post("/landing", handleApi1Landing);
router.get("/landing", handleApi1Landing);

// API 2: Verify request originated at Odisha One
router.post("/verify-request", handleApi2VerifyRequest);

// API 3: Cancel API to redirect back on Odisha One
router.post("/cancel", handleApi3Cancel);

// API 4: Success API (No Payment)
router.post("/success", handleApi4Success);

// API 9: Push application status to Odisha One
router.post("/push-application-status", handleApi9PushApplicationStatus);

module.exports = router;
