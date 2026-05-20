const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");

const APPLICATION_STATUS_VALUES = Object.values(APPLICATION_STATUS);

const parseStatuses = (value) => {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return rawValues.map((status) => String(status).trim().toUpperCase());
};

const buildStatusWhere = (statuses, params) => {
  if (!statuses.length) return "";
  params.push(statuses);
  return `AND o.application_status::text = ANY($${params.length}::text[])`;
};

const getAEEOfficer = async (userId) => {
  const result = await pool.query(
    `
      SELECT um.id, um.login_id, um.user_type_id, um.division_code, ut.type_name
      FROM user_master um
      LEFT JOIN user_type_master ut ON ut.id = um.user_type_id
      WHERE um.id = $1
      LIMIT 1
    `,
    [userId]
  );

  const officer = result.rows[0] || null;
  if (!officer) return null;
  if (String(officer.type_name || "").trim().toUpperCase() !== "AEE") return { unauthorized: true };
  if (!officer.division_code) return { missingDivision: true };
  return officer;
};

const getAEEDashboardApplicationSummary = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const officer = await getAEEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });
    if (officer.unauthorized) return res.status(403).json({ error: "Unauthorized user type" });
    if (officer.missingDivision) return res.status(400).json({ error: "AEE user has no division assigned" });

    const result = await pool.query(
      `
        SELECT COUNT(DISTINCT o.application_id)::int AS total_applications
        FROM organisation o
        INNER JOIN dbrap_lgd_block lb
          ON lb.block_code::text = o.block_code::text
        WHERE COALESCE(lb.division_code::text, '') = COALESCE($1::text, '')
      `,
      [officer.division_code]
    );

    return res.status(200).json({
      totalApplications: Number(result.rows[0]?.total_applications || 0),
    });
  } catch (error) {
    console.error("getAEEDashboardApplicationSummary error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getAEEDashboardApplications = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const statuses = parseStatuses(req.query.application_status);

    if (!userId) return res.status(400).json({ error: "User ID is required" });
    if (statuses.some((status) => !APPLICATION_STATUS_VALUES.includes(status))) {
      return res.status(400).json({
        error: "Invalid application status filter value",
        allowedStatuses: APPLICATION_STATUS_VALUES,
      });
    }

    const officer = await getAEEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });
    if (officer.unauthorized) return res.status(403).json({ error: "Unauthorized user type" });
    if (officer.missingDivision) return res.status(400).json({ error: "AEE user has no division assigned" });

    const params = [officer.division_code];
    const statusWhere = buildStatusWhere(statuses, params);

    const result = await pool.query(
      `
        SELECT o.application_id, o.organisation_name, o.establishment_type, o.application_status,
               o.created_at, o.update_on, o.forward_on, o.site_visit_report, o.site_visit_report_upload_on, o.approved_on,
               o.district_code, o.block_code,
               o.district, o.block, o.gram_panchayat, o.village, o.habitation,
               o.name, o.gender, o.email, o.mobile_number, o.type_of_connection, o.water_requirement,
               o.property_proof, o.registration_proof, o.ownership_proof,
               o.owner_indemnity_bond, o.identity_proof
        FROM organisation o
        INNER JOIN dbrap_lgd_block lb
          ON lb.block_code::text = o.block_code::text
        WHERE COALESCE(lb.division_code::text, '') = COALESCE($1::text, '')
          ${statusWhere}
        ORDER BY o.created_at DESC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getAEEDashboardApplications error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  getAEEDashboardApplicationSummary,
  getAEEDashboardApplications,
};
