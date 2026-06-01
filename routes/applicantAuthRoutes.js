const express = require("express");
const {
  checkApplicantMobile,
  loginApplicant,
  loginApplicantWithPassword,
} = require("../controllers/applicantAuthController");
const { sendOTPSMS } = require("../utility/sms"); // ← ADD

const router = express.Router();

router.get("/check-mobile", checkApplicantMobile);
router.post("/login", loginApplicant);
router.post("/login-password", loginApplicantWithPassword);

// ← ADD THIS
router.post("/send-otp", async (req, res) => {
  const { mobile, otp } = req.body;
  if (!mobile || !otp)
    return res.status(400).json({ error: "Mobile and OTP are required." });
  try {
    await sendOTPSMS(mobile, otp);
    res.json({ success: true });
  } catch (err) {
    console.error("SMS send failed:", err.message);
    res.status(502).json({ error: "Failed to send OTP via SMS gateway." });
  }
});

module.exports = router;