const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");
const { saveApplicationHistory } = require("./historyController");
const { handleSlaOnStatusChange } = require("./slaTrackingController");

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
        WHERE o.application_status = $2
        ORDER BY o.money_receipt_upload_on DESC NULLS LAST
      `,
      [userId, APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED]
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

  const allowedActions = [
    APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED,
    APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED,
  ];

  if (!allowedActions.includes(action)) {
    return res.status(400).json({ error: "Invalid action", allowedActions });
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

    const oldStatus       = currentResult.rows[0].application_status;
    const rejectionCount  = Number(currentResult.rows[0].payment_rejection_count) || 0;

    // ── Determine final status ─────────────────────────────────────────────
    // If JE rejects AND this is already the 1st rejection (count >= 1),
    // permanently reject the application.
    let finalStatus = action;
    if (action === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED && rejectionCount >= 1) {
      finalStatus = APPLICATION_STATUS.APPLICATION_REJECTED;
    }

    // ── Update organisation ────────────────────────────────────────────────
    const result = await pool.query(
      `
        UPDATE organisation
        SET
          application_status       = $1::varchar,
          update_on                = NOW(),
          remarks                  = COALESCE($3::varchar, remarks),
          -- increment count only on a rejection action (not on permanent reject)
          payment_rejection_count  = CASE
            WHEN $4::varchar = $5::varchar
            THEN COALESCE(payment_rejection_count, 0) + 1
            ELSE payment_rejection_count
          END,
          -- clear verify timestamp when rejecting so re-upload is clean
          money_receipt_verify_on  = CASE
            WHEN $1::varchar = $6::varchar THEN NOW()
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
        finalStatus,                                          // $1 – new status
        applicationId,                                        // $2
        remarks || null,                                      // $3 – remark text
        action,                                               // $4 – what JE chose
        APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED,         // $5 – rejection constant
        APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED,          // $6 – verified constant
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

    // ── SLA tracking ──────────────────────────────────────────────────────
    await handleSlaOnStatusChange({
      applicationId,
      newStatus:   finalStatus,
      actorUserId: userId || null,
      assignedTo:  req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });

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