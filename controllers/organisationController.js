const fs = require("fs");
const path = require("path");
const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");
const { saveApplicationHistory } = require("./historyController");
const { handleSlaOnStatusChange } = require("./slaTrackingController");

const APPLICATION_STATUS_VALUES = Object.values(APPLICATION_STATUS);
const isValidApplicationStatus = (value) => APPLICATION_STATUS_VALUES.includes(value);
const normalizeApplicationStatus = (value) => String(value || "").trim().toUpperCase();

const registerOrganisation = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      organisation_name,
      establishment_type,
      block_code,
      district_code,   // ✅ now received and saved
      district,
      block,
      gram_panchayat,
      village,
      habitation,
      name,
      gender,
      email,
      mobile_number,
      type_of_connection,
      water_requirement
    } = req.body;

    if (!block_code) {
      return res.status(400).json({ error: "Block code is required to generate application ID" });
    }

    const files = req.files || {};
    const property_proof = files["property_proof"] ? files["property_proof"][0].path : null;
    const registration_proof = files["registration_proof"] ? files["registration_proof"][0].path : null;
    const ownership_proof = files["ownership_proof"] ? files["ownership_proof"][0].path : null;
    const owner_indemnity_bond = files["owner_indemnity_bond"] ? files["owner_indemnity_bond"][0].path : null;
    const identity_proof = files["identity_proof"] ? files["identity_proof"][0].path : null;

    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(block_code)]);

    // Sanitize block_code — strip "CA" prefix if accidentally included
    const rawBlockCode = String(block_code).replace(/^CA/i, "").trim();
    const applicationPrefix = `CA${rawBlockCode}`;
    const serialLength = 5;

    const serialResult = await client.query(
      `SELECT COALESCE(
        MAX(CAST(RIGHT(application_id, $2) AS INTEGER)),
        0
      ) AS last_serial
      FROM organisation
      WHERE application_id LIKE $1`,
      [`${applicationPrefix}%`, serialLength]
    );

    const nextSerial = Number(serialResult.rows[0]?.last_serial || 0) + 1;
    const application_id = `${applicationPrefix}${String(nextSerial).padStart(serialLength, "0")}`;

    // ✅ district_code and block_code columns added to INSERT
    const query = `
      INSERT INTO organisation
      (
        application_id,
        organisation_name, establishment_type,
        district_code, block_code,
        district, block, gram_panchayat, village, habitation,
        name, gender, email, mobile_number, type_of_connection, water_requirement,
        application_status,
        property_proof, registration_proof, ownership_proof, owner_indemnity_bond, identity_proof
      )
      VALUES (
        $1,
        $2, $3,
        $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        $17,
        $18, $19, $20, $21, $22
      )
      RETURNING *
    `;

    const values = [
      application_id,
      organisation_name,
      establishment_type,
      district_code || null,   // ✅ saved
      rawBlockCode,            // ✅ saved (sanitized)
      district,
      block,
      gram_panchayat,
      village,
      habitation,
      name,
      gender,
      email,
      mobile_number,
      type_of_connection,
      water_requirement,
      APPLICATION_STATUS.APPLICATION_SUBMITTED,
      property_proof,
      registration_proof,
      ownership_proof,
      owner_indemnity_bond,
      identity_proof
    ];

    const result = await client.query(`${query}`, values);
    await client.query("COMMIT");
await saveApplicationHistory(
  application_id,                           // applicationId
  null,                                     // userId  — no applicant_user_id in this controller's flow
  name,                                     // userName — from req.body
  APPLICATION_STATUS.APPLICATION_SUBMITTED, // actionType
  null,                                     // oldValue → null (first submission)
  APPLICATION_STATUS.APPLICATION_SUBMITTED, // newValue
  "Application submitted by applicant"
);

    await handleSlaOnStatusChange({
      applicationId: application_id,
      newStatus: APPLICATION_STATUS.APPLICATION_SUBMITTED,
      actorUserId: null,
      assignedTo: req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });
    res.status(201).json({
      message: "Organisation registered successfully",
      data: result.rows[0]
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback failed:", rollbackError);
    }
    console.error(error);
    res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

const getOrganisations = async (req, res) => {
  const requestedStatus = normalizeApplicationStatus(
    req.query.application_status || APPLICATION_STATUS.APPLICATION_SUBMITTED
  );

  if (!isValidApplicationStatus(requestedStatus)) {
    return res.status(400).json({
      error: "Invalid application status filter value",
      allowedStatuses: APPLICATION_STATUS_VALUES,
    });
  }

  try {
    const userId = req.query.userId;

const result = await pool.query(
`
SELECT
 o.application_id,
 o.organisation_name,
 o.application_status,
 o.block,
 o.block_code
FROM organisation o

JOIN dbrap_lgd_block b
 ON b.block_code::text = o.block_code::text

JOIN dbrap_division dv
 ON dv.division_code::text = b.division_code::text

JOIN user_master u
 ON u.district_code::text = dv.dist_id::text

WHERE u.login_id=$1
AND o.application_status=$2

ORDER BY o.created_at DESC
`,
[
 userId,
 requestedStatus
]
);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server Error" });
  }
};

const updateOrganisationStatus = async (req, res) => {
  const applicationId = String(req.params.applicationId || "").trim();
  const applicationStatus = normalizeApplicationStatus(req.body.application_status);

  if (!applicationId) {
    return res.status(400).json({ error: "Application ID is required" });
  }

  if (!applicationStatus) {
    return res.status(400).json({ error: "Application status is required" });
  }

  if (!isValidApplicationStatus(applicationStatus)) {
    return res.status(400).json({
      error: "Invalid application status value",
      allowedStatuses: APPLICATION_STATUS_VALUES,
    });
  }

  try {
const currentResult = await pool.query(
      `SELECT application_status, name, applicant_user_id FROM organisation WHERE application_id = $1 LIMIT 1`,
      [applicationId]
    );
    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    const oldStatus = currentResult.rows[0].application_status;         // ADD
    const applicantUserId = currentResult.rows[0].applicant_user_id;    // ADD
    const applicantName = currentResult.rows[0].name;                   // ADD

   const result = await pool.query(
  `
  UPDATE organisation
  SET application_status = $1::varchar,
      update_on = NOW(),
      remarks = COALESCE($3::varchar, remarks)
  WHERE application_id = $2
  RETURNING application_id, organisation_name, application_status,
            created_at, update_on, remarks
  `,
  [applicationStatus, applicationId, req.body.remarks || null]
);
await saveApplicationHistory(
      applicationId,          // applicationId
  req.body.userId || null,   // JE officer verifying payment
      applicantName,          // userName
      applicationStatus,      // actionType → current (new) status
      oldStatus,              // oldValue   → what it WAS
      applicationStatus,      // newValue   → what it changed TO
      req.body.remarks || null
    );

    await handleSlaOnStatusChange({
      applicationId,
      newStatus: applicationStatus,
      actorUserId: req.body.userId || null,
      assignedTo: req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    return res.status(200).json({
      message: "Organisation application status updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const uploadSiteVisitReport = async (req, res) => {
  const applicationId = String(req.params.applicationId || "").trim();
  const reportFile = req.file || null;

  if (!applicationId) {
    return res.status(400).json({ error: "Application ID is required" });
  }

  if (!reportFile) {
    return res.status(400).json({ error: "Site visit report file is required" });
  }

  try {

     const currentResult = await pool.query(
      `SELECT application_status, name, applicant_user_id FROM organisation WHERE application_id = $1 LIMIT 1`,
      [applicationId]
    );
    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    const oldStatus = currentResult.rows[0].application_status;         // ADD
    const applicantUserId = currentResult.rows[0].applicant_user_id;    // ADD
    const applicantName = currentResult.rows[0].name;                  // ADD
    const result = await pool.query(
      `
        UPDATE organisation
        SET site_visit_report = $1,
            application_status = $2,
            update_on = NOW()
        WHERE application_id = $3
        RETURNING application_id, organisation_name, application_status, site_visit_report, update_on
      `,
      [reportFile.path, APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED, applicationId]
    );
await saveApplicationHistory(
      applicationId,
  req.body.userId || null,   
      applicantName,
      APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED, // actionType → current status
      oldStatus,                                       // oldValue   → what it WAS
      APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED, // newValue   → what it changed TO
      "JE site visit report uploaded"
    );

    await handleSlaOnStatusChange({
      applicationId,
      newStatus: APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED,
      actorUserId: req.body.userId || null,
      assignedTo: req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    return res.status(200).json({
      message: "Site visit report uploaded successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const viewSiteVisitReport = async (req, res) => {
  const applicationId = String(req.params.applicationId || "").trim();

  if (!applicationId) {
    return res.status(400).json({ error: "Application ID is required" });
  }

  try {
    const result = await pool.query(
      `
        SELECT site_visit_report
        FROM organisation
        WHERE application_id = $1
        LIMIT 1
      `,
      [applicationId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    const reportPath = result.rows[0]?.site_visit_report;

    if (!reportPath) {
      return res.status(404).json({ error: "Site visit report not available" });
    }

    const resolvedPath = path.resolve(reportPath);

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: "Site visit report file not found" });
    }

    return res.sendFile(resolvedPath);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const DOCUMENT_COLUMNS = {
  property_proof: "property_proof",
  registration_proof: "registration_proof",
  ownership_proof: "ownership_proof",
  owner_indemnity_bond: "owner_indemnity_bond",
  identity_proof: "identity_proof",
};

const viewOrganisationDocument = async (req, res) => {
  const applicationId = String(req.params.applicationId || "").trim();
  const documentType = String(req.params.documentType || "").trim();
  const columnName = DOCUMENT_COLUMNS[documentType];

  if (!applicationId) {
    return res.status(400).json({ error: "Application ID is required" });
  }

  if (!columnName) {
    return res.status(400).json({ error: "Invalid document type" });
  }

  try {
    const result = await pool.query(
      `
        SELECT ${columnName} AS document_path
        FROM organisation
        WHERE application_id = $1
        LIMIT 1
      `,
      [applicationId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }

    const documentPath = result.rows[0]?.document_path;

    if (!documentPath) {
      return res.status(404).json({ error: "Document not available" });
    }

    const resolvedPath = path.resolve(documentPath);

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: "Document file not found" });
    }

    return res.sendFile(resolvedPath);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  registerOrganisation,
  getOrganisations,
  updateOrganisationStatus,
  uploadSiteVisitReport,
  viewSiteVisitReport,
  viewOrganisationDocument,
  APPLICATION_STATUS,
};
