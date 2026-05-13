const express = require("express");
const {
  getJEBlock,
  getJEApplications,
  getJEPaymentDetails,
  createJEPaymentDetail,
} = require("../controllers/jePaymentDetailsController");

const router = express.Router();

router.get("/blocks", getJEBlock);
router.get("/applications", getJEApplications);
router.get("/payments", getJEPaymentDetails);
router.post("/payments", createJEPaymentDetail);

module.exports = router;
