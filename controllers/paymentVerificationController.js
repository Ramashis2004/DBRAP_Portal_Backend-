const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");
const { saveApplicationHistory } = require("./historyController");
const { handleSlaOnStatusChange } = require("./slaTrackingController");
const { pushApplicationStatusToOdishaOne } = require("./odishaOneController");

const getPaymentVerificationApplications = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const officerResult = await pool.query(
      `SELECT id, user_type_id, block_code FROM user_master WHERE id = $1 LIMIT 1`,
      [userId]
    );

    if (officerResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const officer = officerResult.rows[0];
    const userTypeId = Number(officer.user_type_id);

    if (userTypeId !== 4) {
      return res.status(403).json({
        error: "Unauthorized: Only JE users can access payment verification",
      });
    }

    const result = await pool.query(
      `
        SELECT
          o.application_id,
          o.organisation_name,
          o.establishment_type,
          o.application_status,
          o.created_at,
          o.update_on,
          o.forward_on,
          o.site_visit_report,
          o.site_visit_report_upload_on,
          o.approved_on,
          o.money_receipt_upload_on,
          o.money_receipt_verify_on,
          o.district_code,
          o.block_code,
          o.district,
          o.block,
          o.gram_panchayat,
          o.village,
          o.habitation,
          o.name,
          o.gender,
          o.email,
          o.mobile_number,
          o.type_of_connection,
          o.water_requirement,
          o.property_proof,
          o.registration_proof,
          o.ownership_proof,
          o.owner_indemnity_bond,
          o.identity_proof,
          o.amount,
          o.date_of_payment,
          o.money_receipt,
          o.payment_rejection_count
        FROM organisation o
        INNER JOIN user_master um
          ON um.id = $1
         AND um.user_type_id = 4
         AND COALESCE(um.block_code::text, '') = COALESCE(o.block_code::text, '')
        WHERE o.application_status = ANY($2::text[])
        ORDER BY o.money_receipt_upload_on DESC NULLS LAST
      `,
      [userId, [
        APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
        APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED_FOR_CANCELLATION,
        APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED_FOR_TRANSFER,
      ]]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getPaymentVerificationApplications error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const verifyPayment = async (req, res) => {
  const applicationId = String(req.params.applicationId || "").trim();
  const { action, remarks, userId } = req.body;

  if (!applicationId) {
    return res.status(400).json({ error: "Application ID is required" });
  }
  if (!action) {
    return res.status(400).json({ error: "Action is required" });
  }

  try {
    // ── Fetch current state ────────────────────────────────────────────────
    const currentResult = await pool.query(
      `SELECT application_status, payment_rejection_count
       FROM organisation
       WHERE application_id = $1
       LIMIT 1`,
      [applicationId]
    );

    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: "Application not found" });
    }

    const currentStatus = String(currentResult.rows[0]?.application_status || "");
    const allowedActions = currentStatus === APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED_FOR_TRANSFER
      ? [APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED_FOR_TRANSFER, APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_TRANSFER]
      : currentStatus === APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED_FOR_CANCELLATION
      ? [
          APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED_FOR_CANCELLATION,
          APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_CANCELLATION,
        ]
      : [
          APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED,
          APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED,
        ];

    if (!allowedActions.includes(action)) {
      return res.status(400).json({ error: "Invalid action", allowedActions });
    }

    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: "Application not found" });
    }

    const oldStatus       = currentResult.rows[0].application_status;
    const rejectionCount  = Number(currentResult.rows[0].payment_rejection_count) || 0;

    // ── Determine final status ─────────────────────────────────────────────
    let finalStatus = action;
    if (
      (action === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED || action === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_CANCELLATION || action === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_TRANSFER) &&
      rejectionCount >= 1
    ) {
      finalStatus = action === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_TRANSFER
        ? APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_TRANSFER
        : action === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_CANCELLATION
        ? APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_CANCELLATION
        : APPLICATION_STATUS.APPLICATION_REJECTED;
    }

    // ── Update organisation ────────────────────────────────────────────────
    const result = await pool.query(
      `
        UPDATE organisation
        SET
          application_status       = $1::varchar,
          update_on                = NOW(),
          remarks                  = COALESCE($3::varchar, remarks),
          payment_rejection_count  = CASE
            WHEN $4::varchar IN ($5::varchar, $7::varchar, $9::varchar)
            THEN COALESCE(payment_rejection_count, 0) + 1
            ELSE payment_rejection_count
          END,
          money_receipt_verify_on  = CASE
            WHEN $1::varchar IN ($6::varchar, $8::varchar, $10::varchar) THEN NOW()
            ELSE money_receipt_verify_on
          END
        WHERE application_id = $2
        RETURNING
          application_id,
          organisation_name,
          application_status,
          update_on,
          remarks,
          payment_rejection_count
      `,
      [
        finalStatus,
        applicationId,
        remarks || null,
        action,
        APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED,
        APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED,
        APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_CANCELLATION,
        APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED_FOR_CANCELLATION,
        APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED_FOR_TRANSFER,
        APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED_FOR_TRANSFER,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Application not found" });
    }

    // ── Save history with remarks ──────────────────────────────────────────
    // remarks are passed as the last argument so they appear in history table
    await saveApplicationHistory(
      applicationId,
      userId || null,
      null,
      finalStatus,
      oldStatus,
      finalStatus,
      remarks || null
    );

    await handleSlaOnStatusChange({
      applicationId,
      newStatus:   finalStatus,
      actorUserId: userId || null,
      assignedTo:  req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });

    // Trigger API-9 for Odisha One when PAYMENT_RECEIPT_VERIFIED
    if (
      finalStatus === APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED ||
      finalStatus === APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED_FOR_CANCELLATION
    ) {
      pushApplicationStatusToOdishaOne(applicationId, finalStatus, remarks || "").catch((err) => {
        console.error("API-9 payment verification push error:", err.message);
      });
    }

    return res.status(200).json({
      message: "Payment verification status updated successfully",
      data: result.rows[0],
      // tell the front-end whether this was a permanent rejection
      permanentlyRejected: finalStatus === APPLICATION_STATUS.APPLICATION_REJECTED,
    });
  } catch (error) {
    console.error("verifyPayment error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { getPaymentVerificationApplications, verifyPayment };