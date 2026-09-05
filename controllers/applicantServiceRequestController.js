const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");
const { saveApplicationHistory } = require("./historyController");
const { handleSlaOnStatusChange } = require("./slaTrackingController");
const { hashPassword, generateApplicantUserId, generatePassword, sendCredentialsSms } = require("./authController");

const REQUEST_TYPES = Object.freeze({
  CANCELLATION: "CANCELLATION",
  AMENDMENT: "AMENDMENT",
});

const CONNECTION_DETAILS_STATUSES = [
  "CONNECTION_DETAILS_UPDATED",
 // "UPDTAED_CONNECTION_DETAILS",
];

const DOCUMENT_FIELDS = [
  "property_proof",
  "registration_proof",
  "ownership_proof",
  "owner_indemnity_bond",
  "identity_proof",
];

const getApplicant = async (client, applicantUserId) => {
  const result = await client.query(
    `
      SELECT id, user_name, email_id, mobile_no
      FROM user_master
      WHERE id = $1
        AND role_id::text = '7'
        AND COALESCE(active_flag, 'Y') = 'Y'
      LIMIT 1
    `,
    [applicantUserId]
  );
  return result.rows[0] || null;
};

const submitApplicantServiceRequest = async (req, res) => {
  const client = await pool.connect();

  try {
    const requestType = String(req.body.request_type || "").trim().toUpperCase();
    const applicantUserId = String(req.body.applicant_user_id || "").trim();
    const originalApplicationId = String(req.body.original_application_id || "").trim();
    const transferUserFlag = requestType === REQUEST_TYPES.CANCELLATION && String(req.body.transfer_user_flag || "false") === "true";

    if (!Object.values(REQUEST_TYPES).includes(requestType)) {
      return res.status(400).json({ error: "Invalid request type" });
    }
    if (!applicantUserId || !originalApplicationId) {
      return res.status(400).json({ error: "Applicant and application details are required" });
    }

    if (requestType === REQUEST_TYPES.CANCELLATION) {
      const required = ["request_reason", "preferred_disconnection_date", "outstanding_tariff_paid"];
      if (required.some((key) => !String(req.body[key] || "").trim())) {
        return res.status(400).json({ error: "Please complete all required cancellation fields" });
      }
      if (transferUserFlag) {
        const requiredTransferFields = ["transfer_user_name", "transfer_user_mobile", "transfer_user_email", "transfer_user_gender", "transfer_user_organisation"];
        if (requiredTransferFields.some((key) => !String(req.body[key] || "").trim())) {
          return res.status(400).json({ error: "Please complete all new user details" });
        }
        if (!/^[6-9]\d{9}$/.test(String(req.body.transfer_user_mobile).trim())) {
          return res.status(400).json({ error: "New user mobile number is invalid" });
        }
      }
    }

    if (requestType === REQUEST_TYPES.AMENDMENT) {
      const required = [
        "new_organisation_name",
        "new_establishment_type",
        "new_type_of_connection",
        "new_water_requirement",
        "amendment_reason",
      ];
      if (required.some((key) => !String(req.body[key] || "").trim())) {
        return res.status(400).json({ error: "Please complete all required amendment fields" });
      }
    }

    if (requestType === REQUEST_TYPES.AMENDMENT || requestType === REQUEST_TYPES.CANCELLATION) {
      const files = req.files || {};
      if (DOCUMENT_FIELDS.some((key) => !files[key]?.[0]?.path)) {
        return res.status(400).json({ error: "Please upload all required documents" });
      }
    }

    await client.query("BEGIN");

    const applicant = await getApplicant(client, applicantUserId);
    if (!applicant) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Applicant not found" });
    }

    const applicationResult = await client.query(
      `
        SELECT *
        FROM organisation
        WHERE application_id = $1
          AND applicant_user_id = $2
          AND application_status::text = ANY($3::text[])
          AND consumer_id IS NOT NULL
        LIMIT 1
      `,
      [originalApplicationId, applicantUserId, CONNECTION_DETAILS_STATUSES]
    );

    if (applicationResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Original application not found" });
    }

    const submitStatus = transferUserFlag
      ? APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_TRANSFER
      : requestType === REQUEST_TYPES.CANCELLATION
        ? APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_CANCELLATION
        : APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_AMENDMENT;
    const openStatuses = [
      APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_CANCELLATION,
      APPLICATION_STATUS.CANCELLATION_FORWARDED_TO_JE,
      APPLICATION_STATUS.CANCELLATION_SITE_VISIT_REPORT_UPLOADED,
      APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_TRANSFER,
      APPLICATION_STATUS.TRANSFER_FORWARDED_TO_JE,
      APPLICATION_STATUS.TRANSFER_SITE_VISIT_REPORT_UPLOADED,
      APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_AMENDMENT,
      APPLICATION_STATUS.AMENDMENT_FORWARDED_TO_JE,
      APPLICATION_STATUS.AMENDMENT_DOCUMENTS_VERIFIED_BY_JE,
    ];

    if (openStatuses.includes(applicationResult.rows[0].application_status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `A ${requestType.toLowerCase()} request is already in process`,
        request_application_id: originalApplicationId,
      });
    }

    const application = applicationResult.rows[0];
    const files = req.files || {};
    let transferUser = null;
    let generatedTransferPassword = null;

    if (transferUserFlag) {
      const transferMobile = String(req.body.transfer_user_mobile).trim();
      const transferGender = {
        Male: "M",
        Female: "F",
        Other: "O",
      }[String(req.body.transfer_user_gender).trim()] || String(req.body.transfer_user_gender).trim();
      const duplicate = await client.query(
        "SELECT id FROM user_master WHERE mobile_no = $1 OR email_id = $2 LIMIT 1",
        [transferMobile, String(req.body.transfer_user_email).trim().toLowerCase()]
      );
      if (duplicate.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A user with this mobile number or email already exists" });
      }
      const userId = await generateApplicantUserId(client);
      generatedTransferPassword = generatePassword();
      const applicantTypeResult = await client.query(
        "SELECT id FROM user_type_master WHERE UPPER(type_name) = 'APPLICANT' LIMIT 1"
      );
      const userResult = await client.query(
        `INSERT INTO user_master
          (id, user_name, organisation_name, login_id, password, email_id, mobile_no, gender,
           active_flag, created_by, role_id, user_type_id, designation, passwordchange_flag, is_logged)
         VALUES ($1, $2, $3, $1, $4, $5, $6, $7, 'Y', $1, '7', $8, 'Applicant', 'N', false)
         RETURNING id, user_name, login_id, mobile_no, email_id`,
        [
          userId,
          String(req.body.transfer_user_name).trim(),
          String(req.body.transfer_user_organisation).trim(),
          hashPassword(generatedTransferPassword),
          String(req.body.transfer_user_email).trim().toLowerCase(),
          transferMobile,
          transferGender,
          applicantTypeResult.rows[0]?.id || null,
        ]
      );
      transferUser = userResult.rows[0];
    }

    const existingRequestResult = await client.query(
      `
        SELECT application_id
        FROM organisation
        WHERE original_application_id = $1
          AND applicant_user_id = $2
          AND request_type = $3
          AND application_status IN ('APPLICATION_SUBMITTED_FOR_CANCELLATION', 'CANCELLATION_FORWARDED_TO_JE', 'CANCELLATION_SITE_VISIT_REPORT_UPLOADED', 'APPLICATION_SUBMITTED_FOR_TRANSFER', 'TRANSFER_FORWARDED_TO_JE', 'TRANSFER_SITE_VISIT_REPORT_UPLOADED', 'APPLICATION_SUBMITTED_FOR_AMENDMENT', 'AMENDMENT_FORWARDED_TO_JE', 'AMENDMENT_DOCUMENTS_VERIFIED_BY_JE')
        LIMIT 1
      `,
      [originalApplicationId, applicantUserId, requestType]
    );
    if (existingRequestResult.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `A ${requestType.toLowerCase()} request is already in process`,
        request_application_id: existingRequestResult.rows[0].application_id,
      });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `service-request:${requestType}:${String(application.block_code).trim()}`,
    ]);

    const requestPrefix = requestType === REQUEST_TYPES.CANCELLATION ? "CAN" : "AMD";
    const requestIdResult = await client.query(
      `
        SELECT COALESCE(MAX(SUBSTRING(application_id FROM '[0-9]+$')::INTEGER), 0) AS last_serial
        FROM organisation
        WHERE application_id ~ ('^' || $1 || '[0-9]{5}$')
      `,
      [`${requestPrefix}${String(application.block_code).trim()}`]
    );
    const nextSerial = Number(requestIdResult.rows[0]?.last_serial || 0) + 1;
    const requestApplicationId = `${requestPrefix}${String(application.block_code).trim()}${String(nextSerial).padStart(5, "0")}`;

    const insertResult = await client.query(
      `
        INSERT INTO organisation
        (
          application_id, original_application_id, request_type, applicant_user_id,
          consumer_id, organisation_name, establishment_type, district_code, block_code,
          district, block, gram_panchayat_code, gram_panchayat, village, habitation,
          name, gender, email, mobile_number, type_of_connection, type_of_connection_rwss,
          meter_id, initial_meter_reading, meter_make, name_of_project, tapping_point,
          water_requirement, transfer_user_flag, transfer_user_id, transfer_user_name,
          transfer_user_mobile, transfer_user_email, transfer_user_gender, transfer_user_organisation,
          request_reason, preferred_disconnection_date, outstanding_tariff_paid,
          new_organisation_name, new_establishment_type, new_type_of_connection,
          new_water_requirement, amendment_reason, application_status,
          property_proof, registration_proof, ownership_proof, owner_indemnity_bond,
          identity_proof, update_on
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
          $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
          $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, NOW()
        )
        RETURNING *
      `,
      [
        requestApplicationId,
        application.application_id,
        requestType,
        application.applicant_user_id,
        application.consumer_id,
        application.organisation_name,
        application.establishment_type,
        application.district_code,
        application.block_code,
        application.district,
        application.block,
        application.gram_panchayat_code,
        application.gram_panchayat,
        application.village,
        application.habitation,
        application.name,
        application.gender,
        application.email,
        application.mobile_number,
        application.type_of_connection,
        application.type_of_connection_rwss,
        application.meter_id,
        application.initial_meter_reading,
        application.meter_make,
        application.name_of_project,
        application.tapping_point,
        application.water_requirement,
        transferUserFlag,
        transferUser?.id || null,
        transferUser?.user_name || null,
        transferUser?.mobile_no || null,
        transferUser?.email_id || null,
        String(req.body.transfer_user_gender || "").trim() || null,
        String(req.body.transfer_user_organisation || "").trim() || null,
        req.body.request_reason || null,
        req.body.preferred_disconnection_date || null,
        req.body.outstanding_tariff_paid || null,
        req.body.new_organisation_name || null,
        req.body.new_establishment_type || null,
        req.body.new_type_of_connection || null,
        req.body.new_water_requirement || null,
        req.body.amendment_reason || null,
        submitStatus,
        files.property_proof?.[0]?.path || null,
        files.registration_proof?.[0]?.path || null,
        files.ownership_proof?.[0]?.path || null,
        files.owner_indemnity_bond?.[0]?.path || null,
        files.identity_proof?.[0]?.path || null,
      ]
    );

    await saveApplicationHistory(
      requestApplicationId,
      applicantUserId,
      applicant.user_name,
      submitStatus,
      application.application_status,
      submitStatus,
      `${requestType} request submitted by applicant`,
      client
    );

    if (transferUser) {
      await saveApplicationHistory(
        requestApplicationId,
        transferUser.id,
        transferUser.user_name,
        "TRANSFER_USER_CREATED",
        null,
        transferUser.id,
        `Transfer user account created for ${transferUser.mobile_no}`,
        client
      );
    }

    await client.query("COMMIT");

    await handleSlaOnStatusChange({
      applicationId: requestApplicationId,
      newStatus: submitStatus,
      actorUserId: applicantUserId,
      assignedTo: null,
    });

    let transferSmsSent = null;
    let transferSmsError = null;
    if (transferUser) {
      try {
        await sendCredentialsSms({
          mobileNo: transferUser.mobile_no,
          loginId: transferUser.login_id,
          password: generatedTransferPassword,
        });
        transferSmsSent = true;
      } catch (smsError) {
        transferSmsSent = false;
        transferSmsError = smsError.message;
        console.error("Transfer user credentials SMS failed:", smsError);
      }
    }

    return res.status(201).json({
      message: `${requestType} request submitted successfully`,
      data: {
        ...insertResult.rows[0],
        transfer_user: transferUser ? { id: transferUser.id, login_id: transferUser.login_id } : null,
        transfer_sms_sent: transferSmsSent,
        transfer_sms_error: transferSmsError,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Service request rollback failed:", rollbackError);
    }
    console.error("Service request submit error:", error);
    return res.status(500).json({
      error: process.env.NODE_ENV === "production" ? "Server Error" : (error.message || "Server Error"),
    });
  } finally {
    client.release();
  }
};

module.exports = {
  submitApplicantServiceRequest,
};
