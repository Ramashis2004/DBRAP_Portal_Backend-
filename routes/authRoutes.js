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

const authMiddleware = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/users/check-existing", checkExistingUserByType);

router.post("/login", loginOfficer);

router.post("/logout", authMiddleware, logoutOfficer);

router.get("/applicant/check-mobile", checkApplicantMobileAvailability);

router.post("/applicant/send-otp", sendApplicantRegistrationOtp);

router.post("/applicant/register", registerApplicant);

router.post("/users", authMiddleware, createOfficerUser);

router.get(
  "/dashboard-config/:userId",
  authMiddleware,
  getOfficerDashboardConfig
);

router.get(
  "/check-session",
  authMiddleware,
  checkSessionValid
);

module.exports = router;