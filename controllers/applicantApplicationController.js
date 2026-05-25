const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");
const { saveApplicationHistory } = require("./historyController"); // ← add this
const { handleSlaOnStatusChange } = require("./slaTrackingController");

const APPLICANT_ROLE_ID = "7";

const genderLabelByCode = {
  M: "Male",
  F: "Female",
  O: "Other",
};

const fetchApplicantById = async (userId, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
     SELECT id, user_name, organisation_name, email_id, mobile_no, gender, role_id
FROM user_master
WHERE id = $1 AND role_id = $2 AND COALESCE(active_flag, 'Y') = 'Y'
LIMIT 1
    `,
    [userId, APPLICANT_ROLE_ID]
  );

  return result.rows[0] || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// getApplicantProfile — unchanged
// ─────────────────────────────────────────────────────────────────────────────
const getApplicantProfile = async (req, res) => {
  try {
    const applicant = await fetchApplicantById(String(req.params.userId || "").trim());

    if (!applicant) {
      return res.status(404).json({ error: "Applicant not found" });
    }

    return res.status(200).json({
      applicant: {
        id: applicant.id,
        name: applicant.user_name,
        organisation_name: applicant.organisation_name || "",  // ← ADD THIS
        email: applicant.email_id,
        mobile_number: applicant.mobile_no,
        gender: genderLabelByCode[applicant.gender] || applicant.gender || "",
      },
    });
  } catch (error) {
    console.error("Applicant profile error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getApplicantNavigation — unchanged
// ─────────────────────────────────────────────────────────────────────────────
const getApplicantNavigation = async (req, res) => {
  try {
    const roleId = Number(req.params.roleId || APPLICANT_ROLE_ID);

    const result = await pool.query(
      `
        SELECT
          m.menu_id, m.menu_name, m.menu_description,
          rmm.serial_no,
          o.option_id, o.option_name, o.option_description, o.option_url,
          o.priority AS option_priority
        FROM dbrap_role_menu_mapping rmm
        INNER JOIN dbrap_menu m
          ON m.menu_id = rmm.menu_id
         AND COALESCE(m.status, true) = true
        LEFT JOIN dbrap_role_options_mapping rom
          ON rom.role_id = rmm.role_id
         AND COALESCE(rom.status, true) = true
        LEFT JOIN dbrap_options o
          ON o.option_id = rom.option_id
         AND o.menu_id = m.menu_id
         AND COALESCE(o.status, true) = true
        WHERE rmm.role_id = $1
        ORDER BY
          COALESCE(rmm.serial_no, 999999),
          COALESCE(o.priority, ''),
          COALESCE(o.option_name, '')
      `,
      [roleId]
    );

    const menuMap = new Map();

    for (const row of result.rows) {
      if (!menuMap.has(row.menu_id)) {
        menuMap.set(row.menu_id, {
          id: row.menu_id,
          key: `menu-${row.menu_id}`,
          label: row.menu_name,
          description: row.menu_description,
          serialNo: row.serial_no,
          options: [],
        });
      }

      if (row.option_id) {
        menuMap.get(row.menu_id).options.push({
          id: row.option_id,
          key: `option-${row.option_id}`,
          label: row.option_name,
          description: row.option_description,
          url: row.option_url,
          priority: row.option_priority,
        });
      }
    }

    return res.status(200).json({ menus: Array.from(menuMap.values()) });
  } catch (error) {
    console.error("Applicant navigation error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// registerApplicantOrganisation — saveApplicationHistory added after INSERT
// ─────────────────────────────────────────────────────────────────────────────
const registerApplicantOrganisation = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      applicant_user_id,
      organisation_name,
      establishment_type,
      block_code,
      district_code,
      district,
      block,
      gram_panchayat_code,
      gram_panchayat,
      village,
      habitation,
      type_of_connection,
      water_requirement,
    } = req.body;

    if (!applicant_user_id) {
      return res.status(400).json({ error: "Applicant user ID is required" });
    }

    if (!block_code) {
      return res.status(400).json({ error: "Block code is required to generate application ID" });
    }

    const requiredFields = {
      organisation_name, establishment_type, district_code,
      district, block, gram_panchayat, village,
      type_of_connection, water_requirement,
    };

    const missingField = Object.entries(requiredFields).find(([, value]) => !String(value || "").trim());
    if (missingField) {
      return res.status(400).json({ error: "Please complete all required fields" });
    }

    const files = req.files || {};
    const property_proof      = files.property_proof      ? files.property_proof[0].path      : null;
    const registration_proof  = files.registration_proof  ? files.registration_proof[0].path  : null;
    const ownership_proof     = files.ownership_proof     ? files.ownership_proof[0].path      : null;
    const owner_indemnity_bond = files.owner_indemnity_bond ? files.owner_indemnity_bond[0].path : null;
    const identity_proof      = files.identity_proof      ? files.identity_proof[0].path      : null;

    if (!property_proof || !registration_proof || !ownership_proof || !owner_indemnity_bond || !identity_proof) {
      return res.status(400).json({ error: "Please upload all required documents" });
    }

    await client.query("BEGIN");

    const applicant = await fetchApplicantById(String(applicant_user_id).trim(), client);
    if (!applicant) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Applicant not found" });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(block_code)]);

    const rawBlockCode = String(block_code).replace(/^CA/i, "").trim();
    const applicationPrefix = `CA${rawBlockCode}`;
    const serialLength = 5;

    const serialResult = await client.query(
      `
        SELECT COALESCE(MAX(CAST(RIGHT(application_id, $2) AS INTEGER)), 0) AS last_serial
        FROM organisation
        WHERE application_id LIKE $1
      `,
      [`${applicationPrefix}%`, serialLength]
    );

    const nextSerial = Number(serialResult.rows[0]?.last_serial || 0) + 1;
    const application_id = `${applicationPrefix}${String(nextSerial).padStart(serialLength, "0")}`;

    const insertResult = await client.query(
      `
        INSERT INTO organisation
        (
          applicant_user_id, application_id,
          organisation_name, establishment_type,
          district_code, block_code,
          district, block, gram_panchayat_code, gram_panchayat, village, habitation,
          name, gender, email, mobile_number,
          type_of_connection, water_requirement,
          application_status,
          property_proof, registration_proof, ownership_proof,
          owner_indemnity_bond, identity_proof
        )
        VALUES (
          $1,  $2,
          $3,  $4,
          $5,  $6,
          $7,  $8,  $9,  $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18,
          $19,
          $20, $21, $22, $23, $24
        )
        RETURNING *
      `,
      [
        applicant.id,
        application_id,
        organisation_name,
        establishment_type,
        district_code || null,
        rawBlockCode,
        district,
        block,
        gram_panchayat_code || null,
        gram_panchayat,
        village,
        String(habitation || "").trim() || null,
        applicant.user_name,
        genderLabelByCode[applicant.gender] || applicant.gender || "",
        applicant.email_id,
        applicant.mobile_no,
        type_of_connection,
        water_requirement,
        APPLICATION_STATUS.APPLICATION_SUBMITTED, // ← status set here
        property_proof,
        registration_proof,
        ownership_proof,
        owner_indemnity_bond,
        identity_proof,
      ]
    );

    // ── Save application history ──────────────────────────────────────────────
    // action_type = APPLICATION_SUBMITTED  (current status)
    // old_value   = null                   (no prior status — first submission)
    // new_value   = APPLICATION_SUBMITTED  (what it changed to)
    await saveApplicationHistory(
      application_id,                           // applicationId
      applicant.id,                             // userId      (who submitted)
      applicant.user_name,                      // userName
      APPLICATION_STATUS.APPLICATION_SUBMITTED, // actionType  → current status
      null,                                     // oldValue    → none on first submit
      APPLICATION_STATUS.APPLICATION_SUBMITTED, // newValue    → status it became
      "Application submitted by applicant",     // remarks
      client
    );
    // ─────────────────────────────────────────────────────────────────────────

    await client.query("COMMIT");

    await handleSlaOnStatusChange({
      applicationId: application_id,
      newStatus: APPLICATION_STATUS.APPLICATION_SUBMITTED,
      actorUserId: applicant.id,
      assignedTo: null,
    });

    return res.status(201).json({
      message: "Organisation registered successfully",
      data: insertResult.rows[0],
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Applicant organisation rollback failed:", rollbackError);
    }
    console.error("Applicant organisation registration error:", error);
    return res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

const updateReturnedApplicantOrganisation = async (req, res) => {
  const client = await pool.connect();

  try {
    const applicationId = String(req.params.applicationId || "").trim();
    const {
      applicant_user_id,
      organisation_name,
      establishment_type,
      block_code,
      district_code,
      district,
      block,
      gram_panchayat_code,
      gram_panchayat,
      village,
      habitation,
      type_of_connection,
      water_requirement,
    } = req.body;

    if (!applicationId) return res.status(400).json({ error: "Application ID is required" });
    if (!applicant_user_id) return res.status(400).json({ error: "Applicant user ID is required" });

    const requiredFields = {
      organisation_name, establishment_type, district_code,
      district, block_code, block, gram_panchayat_code, gram_panchayat, village,
      type_of_connection, water_requirement,
    };

    const missingField = Object.entries(requiredFields).find(([, value]) => !String(value || "").trim());
    if (missingField) return res.status(400).json({ error: "Please complete all required fields" });

    const files = req.files || {};
    const property_proof = files.property_proof ? files.property_proof[0].path : null;
    const registration_proof = files.registration_proof ? files.registration_proof[0].path : null;
    const ownership_proof = files.ownership_proof ? files.ownership_proof[0].path : null;
    const owner_indemnity_bond = files.owner_indemnity_bond ? files.owner_indemnity_bond[0].path : null;
    const identity_proof = files.identity_proof ? files.identity_proof[0].path : null;

    await client.query("BEGIN");

    const applicant = await fetchApplicantById(String(applicant_user_id).trim(), client);
    if (!applicant) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Applicant not found" });
    }

    const currentResult = await client.query(
      `
        SELECT application_id, application_status
        FROM organisation
        WHERE application_id = $1
          AND applicant_user_id = $2
        LIMIT 1
      `,
      [applicationId, applicant.id]
    );

    if (currentResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Returned application not found" });
    }

    const oldStatus = String(currentResult.rows[0].application_status || "").toUpperCase();
    if (oldStatus !== APPLICATION_STATUS.APPLICATION_RETURNED_TO_APPLICANT) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Only returned applications can be resubmitted" });
    }

    const updateResult = await client.query(
      `
        UPDATE organisation
        SET organisation_name = $1,
            establishment_type = $2,
            district_code = $3,
            block_code = $4,
            district = $5,
            block = $6,
            gram_panchayat_code = $7,
            gram_panchayat = $8,
            village = $9,
            habitation = $10,
            type_of_connection = $11,
            water_requirement = $12,
            property_proof = COALESCE($13::varchar, property_proof),
            registration_proof = COALESCE($14::varchar, registration_proof),
            ownership_proof = COALESCE($15::varchar, ownership_proof),
            owner_indemnity_bond = COALESCE($16::varchar, owner_indemnity_bond),
            identity_proof = COALESCE($17::varchar, identity_proof),
            application_status = $18,
            update_on = NOW(),
            remarks = NULL
        WHERE application_id = $19
          AND applicant_user_id = $20
        RETURNING *
      `,
      [
        organisation_name,
        establishment_type,
        district_code,
        String(block_code).replace(/^CA/i, "").trim(),
        district,
        block,
        gram_panchayat_code || null,
        gram_panchayat,
        village,
        String(habitation || "").trim() || null,
        type_of_connection,
        water_requirement,
        property_proof,
        registration_proof,
        ownership_proof,
        owner_indemnity_bond,
        identity_proof,
        APPLICATION_STATUS.APPLICATION_SUBMITTED,
        applicationId,
        applicant.id,
      ]
    );

    await saveApplicationHistory(
      applicationId,
      applicant.id,
      applicant.user_name,
      APPLICATION_STATUS.APPLICATION_SUBMITTED,
      oldStatus,
      APPLICATION_STATUS.APPLICATION_SUBMITTED,
      "Returned application resubmitted by applicant",
      client
    );

    await client.query("COMMIT");

    await handleSlaOnStatusChange({
      applicationId,
      newStatus: APPLICATION_STATUS.APPLICATION_SUBMITTED,
      actorUserId: applicant.id,
      assignedTo: null,
    });

    return res.status(200).json({
      message: "Application resubmitted successfully",
      data: updateResult.rows[0],
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Returned applicant organisation update error:", error);
    return res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getApplicantApplicationCount — unchanged
// ─────────────────────────────────────────────────────────────────────────────
const getApplicantApplicationCount = async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const result = await pool.query(
      `SELECT COUNT(*) AS total FROM organisation WHERE applicant_user_id = $1`,
      [userId]
    );

    return res.status(200).json({
      total: Number(result.rows[0]?.total || 0),
    });
  } catch (error) {
    console.error("Application count error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getApplicantApplication = async (req, res) => {

  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const result = await pool.query(
      `SELECT application_id,name,gender,email,mobile_number, organisation_name, establishment_type,
              district, block, gram_panchayat_code, gram_panchayat, village, habitation,
              type_of_connection, water_requirement, application_status, created_at,
              property_proof,
    registration_proof,
    ownership_proof,
    owner_indemnity_bond,
    identity_proof
       FROM organisation
       WHERE applicant_user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ exists: false });
    }

    return res.status(200).json({ exists: true, application: result.rows[0] });
  } catch (error) {
    console.error("Get applicant application error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};
module.exports = {
  getApplicantNavigation,
  getApplicantProfile,
  registerApplicantOrganisation,
  updateReturnedApplicantOrganisation,
  getApplicantApplicationCount,
  getApplicantApplication,
};
