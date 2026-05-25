const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");

/**
 * getPendingForwardToJE  — returns APPLICATION_SUBMITTED only
 * getPendingApproval     — returns APPLICATION_FORWARDED_TO_JE only
 *
 * Both share the same SE-scoped query (join via division_code → block → organisation).
 */

const fetchForUserId = async (userId, statuses) => {
  const officerResult = await pool.query(
    `SELECT id, user_type_id, division_code, block_code FROM user_master WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (officerResult.rows.length === 0) return null;

  const officer = officerResult.rows[0];
  const userTypeId = Number(officer.user_type_id);

  // SE (userTypeId = 2) — division-scoped
  if (userTypeId === 2) {
    const result = await pool.query(
      `
        SELECT o.application_id, o.organisation_name, o.establishment_type, o.application_status,
               o.created_at,o.update_on, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code, o.block_code,
               lb.division_code, dv.division_name,
               COALESCE(ld.district_name, o.district) AS district_name,
               COALESCE(lb.block_name, o.block) AS block_name,
               o.district, o.block, o.gram_panchayat, o.village, o.habitation,
               o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
               o.property_proof, o.registration_proof, o.ownership_proof,
               o.owner_indemnity_bond, o.identity_proof
        FROM organisation o
        INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = o.block_code::text
        LEFT JOIN dbrap_lgd_district ld ON ld.district_code::text = lb.district_code::text
        LEFT JOIN dbrap_division dv
          ON dv.division_code::text = lb.division_code::text
         AND dv.dist_id::text = lb.district_code::text
        INNER JOIN user_master um
          ON um.id = $1
         AND um.user_type_id = 2
         AND COALESCE(um.division_code::text, '') = COALESCE(lb.division_code::text, '')
        WHERE o.application_status = ANY($2::text[])
        ORDER BY o.created_at DESC
      `,
      [userId, statuses]
    );
    return result.rows;
  }

  // JE (userTypeId = 4) — block-scoped
  if (userTypeId === 4) {
    const result = await pool.query(
      `
        SELECT o.application_id, o.organisation_name, o.establishment_type, o.application_status,
               o.created_at, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code, o.block_code,
               lb.division_code, dv.division_name,
               COALESCE(ld.district_name, o.district) AS district_name,
               COALESCE(lb.block_name, o.block) AS block_name,
               o.district, o.block, o.gram_panchayat, o.village, o.habitation,
               o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
               o.property_proof, o.registration_proof, o.ownership_proof,
               o.owner_indemnity_bond, o.identity_proof
        FROM organisation o
        INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = o.block_code::text
        LEFT JOIN dbrap_lgd_district ld ON ld.district_code::text = lb.district_code::text
        LEFT JOIN dbrap_division dv
          ON dv.division_code::text = lb.division_code::text
         AND dv.dist_id::text = lb.district_code::text
        INNER JOIN user_master um
          ON um.id = $1
         AND um.user_type_id = 4
         AND COALESCE(um.block_code::text, '') = COALESCE(o.block_code::text, '')
        WHERE o.application_status = ANY($2::text[])
        ORDER BY o.created_at DESC
      `,
      [userId, statuses]
    );
    return result.rows;
  }

  return null; // unauthorized type
};

const getPendingForwardToJE = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const rows = await fetchForUserId(userId, [APPLICATION_STATUS.APPLICATION_SUBMITTED]);
    if (rows === null) return res.status(403).json({ error: "Unauthorized user type" });

    return res.status(200).json(rows);
  } catch (error) {
    console.error("getPendingForwardToJE error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getPendingApproval = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const rows = await fetchForUserId(userId, [APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED]);
    if (rows === null) return res.status(403).json({ error: "Unauthorized user type" });

    return res.status(200).json(rows);
  } catch (error) {
    console.error("getPendingApproval error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { getPendingForwardToJE, getPendingApproval };
