const express = require("express");
const router = express.Router();
const { sendOtp, verifyOtp, resetPassword } = require("../controllers/forgotPasswordController");

router.post("/officer/forgot-password/send-otp",   sendOtp);
router.post("/officer/forgot-password/verify-otp", verifyOtp);
router.post("/officer/forgot-password/reset",      resetPassword);

module.exports = router;
