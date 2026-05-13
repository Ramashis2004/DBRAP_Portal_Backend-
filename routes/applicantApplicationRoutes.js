const express = require("express");
const upload = require("../middlewares/uploadMiddleware");
const {
  getApplicantNavigation,
  getApplicantProfile,
  registerApplicantOrganisation,
  getApplicantApplicationCount,
  getApplicantApplication
} = require("../controllers/applicantApplicationController");

const router = express.Router();

router.get("/navigation/:roleId", getApplicantNavigation);
router.get("/profile/:userId", getApplicantProfile);
router.post(
  "/register-organisation",
  upload.fields([
    { name: "property_proof", maxCount: 1 },
    { name: "registration_proof", maxCount: 1 },
    { name: "ownership_proof", maxCount: 1 },
    { name: "owner_indemnity_bond", maxCount: 1 },
    { name: "identity_proof", maxCount: 1 },
  ]),
  registerApplicantOrganisation
);
router.get("/application-count/:userId", getApplicantApplicationCount);
router.get("/application/:userId", getApplicantApplication);

module.exports = router;
