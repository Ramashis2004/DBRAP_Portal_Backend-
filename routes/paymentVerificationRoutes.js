const express = require("express");
const {
  getPaymentVerificationApplications,
  verifyPayment,
} = require("../controllers/paymentVerificationController");
const { getMoneyReceiptFile } = require("../controllers/applicantPaymentController");

const router = express.Router();

// GET /api/payment-verification/applications?userId=xxx
// Returns PAYMENT_RECEIPT_UPLOADED applications for the JE's block
router.get("/applications", getPaymentVerificationApplications);

router.get("/:applicationId/money-receipt", getMoneyReceiptFile);

// PATCH /api/payment-verification/:applicationId/verify
// Body: { action: "PAYMENT_RECEIPT_VERIFIED" | "PAYMENT_NOT_VERIFIED", remarks: "..." }
router.patch("/:applicationId/verify", verifyPayment);

module.exports = router;