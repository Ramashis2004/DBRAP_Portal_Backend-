const express = require("express");
const {
  checkApplicantMobileAvailability,
  createOfficerUser,
  getOfficerDashboardConfig,
  loginOfficer,
  logoutOfficer,
  checkSessionValid,  
  registerApplicant,
  sendApplicantRegistrationOtp,
  checkExistingUserByType,
} = require("../controllers/authController");

const router = express.Router();

router.get("/users/check-existing", checkExistingUserByType);
router.post("/login", loginOfficer);
router.post("/logout", logoutOfficer);
router.get("/applicant/check-mobile", checkApplicantMobileAvailability);
router.post("/applicant/send-otp", sendApplicantRegistrationOtp);
router.post("/applicant/register", registerApplicant);
router.post("/users", createOfficerUser);
router.get("/dashboard-config/:userId", getOfficerDashboardConfig);
router.get("/check-session", checkSessionValid);
  
module.exports = router;
