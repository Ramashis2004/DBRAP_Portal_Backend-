const express = require("express");
const {
  checkApplicantMobile,
  sendApplicantOtp,
  loginApplicant,
  loginApplicantWithPassword,
} = require("../controllers/applicantAuthController");

const router = express.Router();

router.get("/check-mobile", checkApplicantMobile);
router.post("/login", loginApplicant);
router.post("/login-password", loginApplicantWithPassword);


router.post("/send-otp", sendApplicantOtp);

module.exports = router;