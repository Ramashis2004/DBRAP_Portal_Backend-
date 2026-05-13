const express = require("express");
const {
  getSEBlocks,
  getSEApplications,
  getSEPaymentDetails,
  createSEPaymentDetail,
} = require("../controllers/sePaymentDetailsController");

const router = express.Router();

router.get("/blocks", getSEBlocks);
router.get("/applications", getSEApplications);
router.get("/payments", getSEPaymentDetails);
router.post("/payments", createSEPaymentDetail);

module.exports = router;
