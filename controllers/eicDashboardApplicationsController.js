const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");

const PENDING_STATUSES = [
  APPLICATION_STATUS.APPLICATION_SUBMITTED,
  APPLICATION_STATUS.APPLICATION_FORWARDED_TO_JE,
  APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED,
  APPLICATION_STATUS.APPLICATION_APPROVED,
  APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
  APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED,
];

const APPROVED_STATUSES = [
  APPLICATION_STATUS.CONNECTION_DETAILS_UPDATED,
];

const getEICOfficer = async (userId) => {
  const result = await pool.query(
    `
      SELECT u.id, u.login_id, u.user_type_id, ut.type_name
      FROM user_master u
      INNER JOIN user_type_master ut ON ut.id = u.user_type_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );

  const officer = result.rows[0] || null;
  if (!officer) return null;
  if (String(officer.type_name || "").trim().toUpperCase() !== "EIC") return { unauthorized: true };
  return officer;
};

const ensureEICOfficer = async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) {
    res.status(400).json({ error: "User ID is required" });
    return null;
  }

  const officer = await getEICOfficer(userId);
  if (!officer) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (officer.unauthorized) {
    res.status(403).json({ error: "Unauthorized: EIC user type required" });
    return null;
  }

  return officer;
};

const countSelect = `
  COUNT(DISTINCT o.application_id)::int AS total_application,
  COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($1::text[]) THEN o.application_id END)::int AS application_approve,
  COUNT(DISTINCT CASE WHEN o.application_status::text = 'APPLICATION_REJECTED' THEN o.application_id END)::int AS application_reject,
  COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($2::text[]) THEN o.application_id END)::int AS application_pending
`;

const parseApplicationStatusFilter = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const getEICDashboardApplicationSummary = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `SELECT COUNT(DISTINCT application_id)::int AS total_applications FROM organisation`
    );

    return res.status(200).json({
      totalApplications: Number(result.rows[0]?.total_applications || 0),
    });
  } catch (error) {
    console.error("getEICDashboardApplicationSummary error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardCircleReport = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `
        SELECT
          c.circle_code,
          c.circle_name,
          ${countSelect}
        FROM dbrap_circle c
        LEFT JOIN dbrap_lgd_district dd ON dd.circle_code::text = c.circle_code::text
        LEFT JOIN dbrap_division dv ON dv.dist_id::text = dd.district_code::text
        LEFT JOIN dbrap_lgd_block lb ON lb.division_code::text = dv.division_code::text
        LEFT JOIN organisation o ON o.block_code::text = lb.block_code::text
        GROUP BY c.circle_code, c.circle_name
        ORDER BY c.circle_name ASC
      `,
      [APPROVED_STATUSES, PENDING_STATUSES]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardCircleReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardDivisionReport = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const circleCode = String(req.query.circleCode || "").trim();
    if (!circleCode) return res.status(400).json({ error: "Circle code is required" });

    const result = await pool.query(
      `
        SELECT
          dv.division_code,
          dv.division_name,
          COUNT(DISTINCT o.application_id)::int AS total_application,
          COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($2::text[]) THEN o.application_id END)::int AS application_approve,
          COUNT(DISTINCT CASE WHEN o.application_status::text = 'APPLICATION_REJECTED' THEN o.application_id END)::int AS application_reject,
          COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($3::text[]) THEN o.application_id END)::int AS application_pending
        FROM dbrap_division dv
        INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        LEFT JOIN dbrap_lgd_block lb ON lb.division_code::text = dv.division_code::text
        LEFT JOIN organisation o ON o.block_code::text = lb.block_code::text
        WHERE dd.circle_code::text = $1::text
        GROUP BY dv.division_code, dv.division_name
        ORDER BY dv.division_name ASC
      `,
      [circleCode, APPROVED_STATUSES, PENDING_STATUSES]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardDivisionReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardBlockReport = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const divisionCode = String(req.query.divisionCode || "").trim();
    if (!divisionCode) return res.status(400).json({ error: "Division code is required" });

    const result = await pool.query(
      `
        SELECT
          lb.block_code,
          lb.block_name,
          COUNT(DISTINCT o.application_id)::int AS total_application,
          COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($2::text[]) THEN o.application_id END)::int AS application_approve,
          COUNT(DISTINCT CASE WHEN o.application_status::text = 'APPLICATION_REJECTED' THEN o.application_id END)::int AS application_reject,
          COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($3::text[]) THEN o.application_id END)::int AS application_pending
        FROM dbrap_lgd_block lb
        LEFT JOIN organisation o ON o.block_code::text = lb.block_code::text
        WHERE lb.division_code::text = $1::text
        GROUP BY lb.block_code, lb.block_name
        ORDER BY lb.block_name ASC
      `,
      [divisionCode, APPROVED_STATUSES, PENDING_STATUSES]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardBlockReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardBlockApplications = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const blockCode = String(req.query.blockCode || "").trim();
    if (!blockCode) return res.status(400).json({ error: "Block code is required" });
    const applicationStatuses = parseApplicationStatusFilter(req.query.application_status);

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
          o.rejected_on,
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
           o.applicant_user_id,
          dv.division_name
        FROM organisation o
        
        INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = o.block_code::text
        INNER JOIN dbrap_division dv ON dv.division_code::text = lb.division_code::text
        INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        WHERE o.block_code::text = $1::text
          AND ($2::text[] IS NULL OR o.application_status::text = ANY($2::text[]))
        ORDER BY o.created_at DESC
      `,
      [blockCode, applicationStatuses.length ? applicationStatuses : null]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardBlockApplications error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  getEICDashboardApplicationSummary,
  getEICDashboardCircleReport,
  getEICDashboardDivisionReport,
  getEICDashboardBlockReport,
  getEICDashboardBlockApplications,
};
