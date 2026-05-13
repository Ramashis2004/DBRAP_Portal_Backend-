const express = require("express");
const router = express.Router();
const upload = require("../middlewares/uploadMiddleware");
const uploadSiteVisitReport = require("../middlewares/siteVisitReportUploadMiddleware");

const {
  registerOrganisation,
  getOrganisations,
  updateOrganisationStatus,
  uploadSiteVisitReport: uploadSiteVisitReportController,
  viewSiteVisitReport,
  viewOrganisationDocument,
} = require("../controllers/organisationController");

router.post(
  "/register",
  upload.fields([
    { name: "property_proof", maxCount: 1 },
    { name: "registration_proof", maxCount: 1 },
    { name: "ownership_proof", maxCount: 1 },
    { name: "owner_indemnity_bond", maxCount: 1 },
    { name: "identity_proof", maxCount: 1 },
  ]),
  registerOrganisation
);
router.get("/organisations", getOrganisations);
router.patch("/organisations/:applicationId/application-status", updateOrganisationStatus);
router.patch("/organisations/:applicationId/status", updateOrganisationStatus);
router.patch(
  "/organisations/:applicationId/site-visit-report",
  uploadSiteVisitReport.single("site_visit_report"),
  uploadSiteVisitReportController
);
router.get("/organisations/:applicationId/site-visit-report", viewSiteVisitReport);
router.get("/organisations/:applicationId/documents/:documentType", viewOrganisationDocument);
module.exports = router;
