const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");

const parseApplicationStatuses = (value) => {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const statuses = rawValues.length > 0 ? rawValues : [APPLICATION_STATUS.APPLICATION_SUBMITTED];

  return statuses.map((status) => String(status).trim().toUpperCase());
};

const APPLICATION_STATUS_VALUES = Object.values(APPLICATION_STATUS);

const getApplicationReceivedApplications = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const applicationStatuses = parseApplicationStatuses(req.query.application_status);

    if (applicationStatuses.some((status) => !APPLICATION_STATUS_VALUES.includes(status))) {
      return res.status(400).json({
        error: "Invalid application status filter value",
        allowedStatuses: APPLICATION_STATUS_VALUES,
      });
    }

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const officerResult = await pool.query(
      `
        SELECT id, user_type_id, division_code, block_code
        FROM user_master
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (officerResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const officer = officerResult.rows[0];
    const userTypeId = Number(officer.user_type_id);

    if (userTypeId === 4) {
      const result = await pool.query(
        `
             SELECT o.application_id::text, o.organisation_name, o.establishment_type, o.application_status,
                 o.created_at, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code::text, o.block_code::text,
               lb.division_code::text, dv.division_name,
                 o.district, o.block, o.gram_panchayat, o.village, o.habitation,
                 o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
                 o.property_proof, o.registration_proof, o.ownership_proof,
                 o.owner_indemnity_bond, o.identity_proof,o.update_on,
                 o.request_type, o.request_reason, o.preferred_disconnection_date,
                 o.outstanding_tariff_paid, o.new_organisation_name,
                 o.new_establishment_type, o.new_contact_person,
                 o.new_mobile_number, o.amendment_reason,
                 o.new_type_of_connection, o.new_water_requirement,
                 o.transfer_user_flag, o.transfer_user_id, o.transfer_user_name,
                 o.transfer_user_mobile, o.transfer_user_email, o.transfer_user_gender,
                 o.transfer_user_organisation
          FROM organisation o
          INNER JOIN user_master um
            ON um.id = $1
           AND um.user_type_id = 4
           AND COALESCE(um.block_code::text, '') = COALESCE(o.block_code::text, '')
          LEFT JOIN dbrap_lgd_block lb
            ON lb.block_code::text = o.block_code::text
          LEFT JOIN dbrap_division dv
            ON dv.division_code::text = lb.division_code::text
           AND dv.dist_id::text = lb.district_code::text
           WHERE o.original_application_id IS NULL
            AND o.application_status = ANY($2::text[])
          UNION ALL
             SELECT sr.application_id::text AS application_id, sr.organisation_name, sr.request_type AS establishment_type, sr.application_status,
                 sr.created_at, sr.forward_on, sr.site_visit_report, sr.site_visit_report_upload_on, sr.approved_on,
               sr.district_code::text, sr.block_code::text,
               lb.division_code::text, dv.division_name,
                 sr.district, sr.block, sr.gram_panchayat, sr.village, sr.habitation,
                 sr.name, NULL AS gender, sr.email, sr.mobile_number, sr.type_of_connection, sr.water_requirement,
                 sr.property_proof, sr.registration_proof, sr.ownership_proof,
                 sr.owner_indemnity_bond, sr.identity_proof, sr.update_on,
                 sr.request_type, sr.request_reason, sr.preferred_disconnection_date,
                 sr.outstanding_tariff_paid, sr.new_organisation_name, sr.new_establishment_type,
                 sr.new_contact_person, sr.new_mobile_number, sr.amendment_reason,
                 sr.new_type_of_connection, sr.new_water_requirement,
                 sr.transfer_user_flag, sr.transfer_user_id, sr.transfer_user_name,
                 sr.transfer_user_mobile, sr.transfer_user_email, sr.transfer_user_gender,
                 sr.transfer_user_organisation
          FROM organisation sr
          INNER JOIN user_master um
            ON um.id = $1
           AND um.user_type_id = 4
           AND COALESCE(um.block_code::text, '') = COALESCE(sr.block_code::text, '')
          LEFT JOIN dbrap_lgd_block lb
            ON lb.block_code::text = sr.block_code::text
          LEFT JOIN dbrap_division dv
            ON dv.division_code::text = lb.division_code::text
           AND dv.dist_id::text = lb.district_code::text
          WHERE sr.original_application_id IS NOT NULL
            AND sr.application_status = ANY($2::text[])
          ORDER BY created_at DESC
        `,
        [userId, applicationStatuses]
      );

      return res.status(200).json(result.rows);
    }

    if (userTypeId === 2) {
      const result = await pool.query(
        `
             SELECT o.application_id::text, o.organisation_name, o.establishment_type, o.application_status,
                 o.created_at, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code::text, o.block_code::text,
               lb.division_code::text, dv.division_name,
                 o.district, o.block, o.gram_panchayat, o.village, o.habitation,
                 o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
                 o.property_proof, o.registration_proof, o.ownership_proof,
                 o.owner_indemnity_bond, o.identity_proof,
                 o.request_type, o.request_reason, o.preferred_disconnection_date,
                 o.outstanding_tariff_paid, o.new_organisation_name,
                 o.new_establishment_type, o.new_contact_person,
                 o.new_mobile_number, o.amendment_reason,
                 o.new_type_of_connection, o.new_water_requirement,
                 o.transfer_user_flag, o.transfer_user_id, o.transfer_user_name,
                 o.transfer_user_mobile, o.transfer_user_email, o.transfer_user_gender,
                 o.transfer_user_organisation
          FROM organisation o
          INNER JOIN dbrap_lgd_block lb
            ON lb.block_code::text = o.block_code::text
          LEFT JOIN dbrap_division dv
            ON dv.division_code::text = lb.division_code::text
           AND dv.dist_id::text = lb.district_code::text
          INNER JOIN user_master um
            ON um.id = $1
           AND um.user_type_id = 2
           AND COALESCE(um.division_code::text, '') = COALESCE(lb.division_code::text, '')
           WHERE o.original_application_id IS NULL
            AND o.application_status = ANY($2::text[])
          UNION ALL
             SELECT sr.application_id::text AS application_id, sr.organisation_name, sr.request_type AS establishment_type, sr.application_status,
                 sr.created_at, sr.forward_on, sr.site_visit_report, sr.site_visit_report_upload_on, sr.approved_on,
               sr.district_code::text, sr.block_code::text,
               lb.division_code::text, dv.division_name,
                 sr.district, sr.block, sr.gram_panchayat, sr.village, sr.habitation,
                 sr.name, NULL AS gender, sr.email, sr.mobile_number, sr.type_of_connection, sr.water_requirement,
                 sr.property_proof, sr.registration_proof, sr.ownership_proof,
                 sr.owner_indemnity_bond, sr.identity_proof,
                 sr.request_type, sr.request_reason, sr.preferred_disconnection_date,
                 sr.outstanding_tariff_paid, sr.new_organisation_name, sr.new_establishment_type,
                 sr.new_contact_person, sr.new_mobile_number, sr.amendment_reason,
                 sr.new_type_of_connection, sr.new_water_requirement,
                 sr.transfer_user_flag, sr.transfer_user_id, sr.transfer_user_name,
                 sr.transfer_user_mobile, sr.transfer_user_email, sr.transfer_user_gender,
                 sr.transfer_user_organisation
          FROM organisation sr
          INNER JOIN dbrap_lgd_block lb
            ON lb.block_code::text = sr.block_code::text
          LEFT JOIN dbrap_division dv
            ON dv.division_code::text = lb.division_code::text
           AND dv.dist_id::text = lb.district_code::text
          INNER JOIN user_master um
            ON um.id = $1
           AND um.user_type_id = 2
           AND COALESCE(um.division_code::text, '') = COALESCE(lb.division_code::text, '')
          WHERE sr.original_application_id IS NOT NULL
            AND sr.application_status = ANY($2::text[])
          ORDER BY created_at DESC
        `,
        [userId, applicationStatuses]
      );

      return res.status(200).json(result.rows);
    }

    return res.status(403).json({ error: "Unauthorized user type" });

  } 
  catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server Error" });
  }
};


module.exports = { getApplicationReceivedApplications };


