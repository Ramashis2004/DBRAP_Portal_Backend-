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
        SELECT o.application_id::text, o.organisation_name, o.establishment_type, o.application_status::text,
               o.created_at,o.update_on, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code::text, o.block_code::text,
               lb.division_code::text, dv.division_name,
               COALESCE(ld.district_name, o.district) AS district_name,
               COALESCE(lb.block_name, o.block) AS block_name,
               o.district, o.block, o.gram_panchayat, o.village, o.habitation,
               o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
               o.original_application_id, o.transfer_user_flag, o.transfer_user_id,
               o.transfer_user_name, o.transfer_user_mobile, o.transfer_user_email,
               o.transfer_user_gender, o.transfer_user_organisation,
               o.property_proof, o.registration_proof, o.ownership_proof,
               o.owner_indemnity_bond, o.identity_proof,
               o.request_type, o.request_reason, o.preferred_disconnection_date,
               o.outstanding_tariff_paid, o.new_organisation_name, o.new_establishment_type,
               o.new_contact_person, o.new_mobile_number, o.amendment_reason,
               o.new_type_of_connection, o.new_water_requirement
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
        WHERE o.original_application_id IS NULL
          AND (o.application_status = ANY($2::text[])
            OR (o.transfer_user_flag = true AND o.request_type IS NULL
              AND o.application_status = 'APPLICATION_SUBMITTED'))
        UNION ALL
        SELECT sr.application_id::text AS application_id,
               sr.organisation_name,
               sr.request_type AS establishment_type,
               CASE
                 WHEN sr.application_status = ANY($2::text[]) THEN sr.application_status
                 ELSE o.application_status
               END AS application_status,
               GREATEST(sr.created_at, o.created_at) AS created_at,
               GREATEST(sr.update_on, o.update_on) AS update_on,
               COALESCE(sr.forward_on, o.forward_on) AS forward_on,
               COALESCE(sr.site_visit_report, o.site_visit_report) AS site_visit_report,
               COALESCE(sr.site_visit_report_upload_on, o.site_visit_report_upload_on) AS site_visit_report_upload_on,
               COALESCE(sr.approved_on, o.approved_on) AS approved_on,
               sr.district_code::text, sr.block_code::text,
               lb.division_code::text, dv.division_name,
               COALESCE(ld.district_name, sr.district) AS district_name,
               COALESCE(lb.block_name, sr.block) AS block_name,
               sr.district, sr.block, sr.gram_panchayat, sr.village, sr.habitation,
               sr.name, NULL AS gender, sr.email, sr.mobile_number, sr.type_of_connection, sr.water_requirement,
               sr.original_application_id, sr.transfer_user_flag, sr.transfer_user_id,
               sr.transfer_user_name, sr.transfer_user_mobile, sr.transfer_user_email,
               sr.transfer_user_gender, sr.transfer_user_organisation,
               sr.property_proof, sr.registration_proof, sr.ownership_proof,
               sr.owner_indemnity_bond, sr.identity_proof,
               sr.request_type, sr.request_reason, sr.preferred_disconnection_date,
               sr.outstanding_tariff_paid, sr.new_organisation_name, sr.new_establishment_type,
               sr.new_contact_person, sr.new_mobile_number, sr.amendment_reason,
               sr.new_type_of_connection, sr.new_water_requirement
        FROM organisation sr
        LEFT JOIN organisation o ON o.application_id = sr.original_application_id
        INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = sr.block_code::text
        LEFT JOIN dbrap_lgd_district ld ON ld.district_code::text = lb.district_code::text
        LEFT JOIN dbrap_division dv
          ON dv.division_code::text = lb.division_code::text
         AND dv.dist_id::text = lb.district_code::text
        INNER JOIN user_master um
          ON um.id = $1
         AND um.user_type_id = 2
         AND COALESCE(um.division_code::text, '') = COALESCE(lb.division_code::text, '')
          WHERE sr.original_application_id IS NOT NULL
            AND (sr.application_status = ANY($2::text[])
              OR (sr.transfer_user_flag = true AND sr.request_type IS NULL
                AND sr.application_status = 'APPLICATION_SUBMITTED'))
             OR (
               o.application_status = ANY($2::text[])
               AND $2::text[] && ARRAY[
                 'CANCELLATION_SITE_VISIT_REPORT_UPLOADED',
                 'AMENDMENT_DOCUMENTS_VERIFIED_BY_JE'
               ]::text[]
             )
        ORDER BY created_at DESC
      `,
      [userId, statuses]
    );
    return result.rows;
  }

  // JE (userTypeId = 4) — block-scoped
  if (userTypeId === 4) {
    const result = await pool.query(
      `
        SELECT o.application_id::text, o.organisation_name, o.establishment_type, o.application_status::text,
           o.created_at, o.update_on, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code::text, o.block_code::text,
               lb.division_code::text, dv.division_name,
               COALESCE(ld.district_name, o.district) AS district_name,
               COALESCE(lb.block_name, o.block) AS block_name,
               o.district, o.block, o.gram_panchayat, o.village, o.habitation,
               o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
               o.original_application_id, o.transfer_user_flag, o.transfer_user_id,
               o.transfer_user_name, o.transfer_user_mobile, o.transfer_user_email,
               o.transfer_user_gender, o.transfer_user_organisation,
               o.property_proof, o.registration_proof, o.ownership_proof,
               o.owner_indemnity_bond, o.identity_proof,
               o.request_type, o.request_reason, o.preferred_disconnection_date,
               o.outstanding_tariff_paid, o.new_organisation_name, o.new_establishment_type,
               o.new_contact_person, o.new_mobile_number, o.amendment_reason,
               o.new_type_of_connection, o.new_water_requirement
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
        WHERE o.original_application_id IS NULL
          AND (o.application_status = ANY($2::text[])
            OR (o.transfer_user_flag = true AND o.request_type IS NULL
              AND o.application_status = 'APPLICATION_SUBMITTED'))
        UNION ALL
        SELECT sr.application_id::text AS application_id,
               sr.organisation_name,
               sr.request_type AS establishment_type,
               sr.application_status,
               sr.created_at, sr.update_on, sr.forward_on, sr.site_visit_report, sr.site_visit_report_upload_on, sr.approved_on,
               sr.district_code::text, sr.block_code::text,
               lb.division_code::text, dv.division_name,
               COALESCE(ld.district_name, sr.district) AS district_name,
               COALESCE(lb.block_name, sr.block) AS block_name,
               sr.district, sr.block, sr.gram_panchayat, sr.village, sr.habitation,
               sr.name, NULL AS gender, sr.email, sr.mobile_number, sr.type_of_connection, sr.water_requirement,
               sr.original_application_id, sr.transfer_user_flag, sr.transfer_user_id,
               sr.transfer_user_name, sr.transfer_user_mobile, sr.transfer_user_email,
               sr.transfer_user_gender, sr.transfer_user_organisation,
               sr.property_proof, sr.registration_proof, sr.ownership_proof,
               sr.owner_indemnity_bond, sr.identity_proof,
               sr.request_type, sr.request_reason, sr.preferred_disconnection_date,
               sr.outstanding_tariff_paid, sr.new_organisation_name, sr.new_establishment_type,
               sr.new_contact_person, sr.new_mobile_number, sr.amendment_reason,
               sr.new_type_of_connection, sr.new_water_requirement
        FROM organisation sr
        INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = sr.block_code::text
        LEFT JOIN dbrap_lgd_district ld ON ld.district_code::text = lb.district_code::text
        LEFT JOIN dbrap_division dv
          ON dv.division_code::text = lb.division_code::text
         AND dv.dist_id::text = lb.district_code::text
        INNER JOIN user_master um
          ON um.id = $1
         AND um.user_type_id = 4
         AND COALESCE(um.block_code::text, '') = COALESCE(sr.block_code::text, '')
        WHERE sr.original_application_id IS NOT NULL
          AND (sr.application_status = ANY($2::text[])
            OR (sr.transfer_user_flag = true AND sr.request_type IS NULL
              AND sr.application_status = 'APPLICATION_SUBMITTED'))
        ORDER BY created_at DESC
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

    const rows = await fetchForUserId(userId, [
      APPLICATION_STATUS.APPLICATION_SUBMITTED,
      APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_CANCELLATION,
      APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_TRANSFER,
      APPLICATION_STATUS.APPLICATION_SUBMITTED_FOR_AMENDMENT,
    ]);
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

    const rows = await fetchForUserId(userId, [
      APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED,
      APPLICATION_STATUS.CANCELLATION_SITE_VISIT_REPORT_UPLOADED,
      APPLICATION_STATUS.TRANSFER_SITE_VISIT_REPORT_UPLOADED,
      APPLICATION_STATUS.AMENDMENT_DOCUMENTS_VERIFIED_BY_JE,
    ]);
    if (rows === null) return res.status(403).json({ error: "Unauthorized user type" });

    return res.status(200).json(rows);
  } catch (error) {
    console.error("getPendingApproval error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { getPendingForwardToJE, getPendingApproval };
