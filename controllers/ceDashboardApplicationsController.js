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

// ─── Auth helper ─────────────────────────────────────────────────────────────

const CE_TYPE_ID  = 6;
const ACE_TYPE_ID = 5; // ← replace with actual ACE user_type_id from user_type_master

const getCEOfficer = async (userId) => {
  const result = await pool.query(
    `SELECT id, login_id, user_type_id, circle_code
       FROM user_master WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const officer = result.rows[0] || null;
  if (!officer) return null;
  const typeId = Number(officer.user_type_id);
  if (typeId !== CE_TYPE_ID && typeId !== ACE_TYPE_ID) return { unauthorized: true };
  const circleCodes = String(officer.circle_code || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!circleCodes.length) return { missingCircle: true };
  return { ...officer, circleCodes };
};
const ensureCEOfficer = async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) {
    res.status(400).json({ error: "User ID is required" });
    return null;
  }

  const officer = await getCEOfficer(userId);
  if (!officer) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (officer.unauthorized) {
    res.status(403).json({ error: "Unauthorized: CE user type required" });
    return null;
  }
  if (officer.missingCircle) {
    res.status(400).json({ error: "CE user has no circle assigned" });
    return null;
  }

  return officer;
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

const countSelect = `
  COUNT(DISTINCT o.application_id)::int AS total_application,
  COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($2::text[]) THEN o.application_id END)::int AS application_approve,
  COUNT(DISTINCT CASE WHEN o.application_status::text = 'APPLICATION_REJECTED'            THEN o.application_id END)::int AS application_reject,
  COUNT(DISTINCT CASE WHEN o.application_status::text = ANY($3::text[]) THEN o.application_id END)::int AS application_pending
`;

const parseApplicationStatusFilter = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// ─── Summary ──────────────────────────────────────────────────────────────────

const getCEDashboardApplicationSummary = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `SELECT COUNT(DISTINCT o.application_id)::int AS total_applications
         FROM organisation o
         INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = o.block_code::text
         INNER JOIN dbrap_division dv  ON dv.division_code::text = lb.division_code::text
         INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        WHERE dd.circle_code::text = ANY($1::text[])`,
      [officer.circleCodes]
    );

    return res.status(200).json({
      totalApplications: Number(result.rows[0]?.total_applications || 0),
    });
  } catch (error) {
    console.error("getCEDashboardApplicationSummary error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─── Circle report ────────────────────────────────────────────────────────────

const getCEDashboardCircleReport = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `SELECT
          c.circle_code,
          c.circle_name,
          ${countSelect}
         FROM dbrap_circle c
         LEFT JOIN dbrap_lgd_district dd ON dd.circle_code::text = c.circle_code::text
         LEFT JOIN dbrap_division dv     ON dv.dist_id::text = dd.district_code::text
         LEFT JOIN dbrap_lgd_block lb    ON lb.division_code::text = dv.division_code::text
         LEFT JOIN organisation o        ON o.block_code::text = lb.block_code::text
        WHERE c.circle_code::text = ANY($1::text[])
        GROUP BY c.circle_code, c.circle_name
        ORDER BY c.circle_name ASC`,
      [officer.circleCodes, APPROVED_STATUSES, PENDING_STATUSES]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardCircleReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─── Division report ──────────────────────────────────────────────────────────

const getCEDashboardDivisionReport = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const circleCode = String(req.query.circleCode || "").trim();
    if (!circleCode) return res.status(400).json({ error: "Circle code is required" });
    if (!officer.circleCodes.map(String).includes(circleCode)) {
      return res.status(403).json({ error: "Circle is not mapped to this CE user" });
    }

    const result = await pool.query(
      `SELECT
          dv.division_code,
          dv.division_name,
          ${countSelect}
         FROM dbrap_division dv
         INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
         LEFT  JOIN dbrap_lgd_block lb    ON lb.division_code::text = dv.division_code::text
         LEFT  JOIN organisation o        ON o.block_code::text = lb.block_code::text
        WHERE dd.circle_code::text = $1::text
        GROUP BY dv.division_code, dv.division_name
        ORDER BY dv.division_name ASC`,
      [circleCode, APPROVED_STATUSES, PENDING_STATUSES]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardDivisionReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─── Block report ─────────────────────────────────────────────────────────────

const getCEDashboardBlockReport = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const divisionCode = String(req.query.divisionCode || "").trim();
    if (!divisionCode) return res.status(400).json({ error: "Division code is required" });

    const result = await pool.query(
      `SELECT
          lb.block_code,
          lb.block_name,
          ${countSelect}
         FROM dbrap_lgd_block lb
         INNER JOIN dbrap_division dv     ON dv.division_code::text = lb.division_code::text
         INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
         LEFT  JOIN organisation o        ON o.block_code::text = lb.block_code::text
        WHERE lb.division_code::text = $1::text
          AND dd.circle_code::text = ANY($4::text[])
        GROUP BY lb.block_code, lb.block_name
        ORDER BY lb.block_name ASC`,
      [divisionCode, APPROVED_STATUSES, PENDING_STATUSES, officer.circleCodes]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardBlockReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─── Panchayat report (NEW) ───────────────────────────────────────────────────
//
//  GET /ce-dashboard/panchayat-report?userId=X&blockCode=Y[&application_status=A,B]
//
//  Returns one row per gram_panchayat inside the given block, with the same
//  total / approve / reject / pending counts as every other level.
//
//  Assumes the organisation table has a `gram_panchayat` (name) column and
//  optionally a `gram_panchayat_code` column.  If your table only stores the
//  name, both columns in the SELECT below will return the name — that is fine,
//  the frontend just needs a stable key and a display value.

const getCEDashboardPanchayatReport = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const blockCode = String(req.query.blockCode || "").trim();
    if (!blockCode) return res.status(400).json({ error: "Block code is required" });

    const applicationStatuses = parseApplicationStatusFilter(req.query.application_status);

    const result = await pool.query(
      `SELECT
          -- Use gram_panchayat_code when available; fall back to name as key
          COALESCE(o.gram_panchayat_code::text, o.gram_panchayat) AS gram_panchayat_code,
          o.gram_panchayat,

          COUNT(DISTINCT o.application_id)::int AS total_application,

          COUNT(DISTINCT CASE
            WHEN ($2::text[] IS NULL OR o.application_status::text = ANY($2::text[]))
              AND o.application_status::text = ANY($3::text[])
            THEN o.application_id END)::int AS application_approve,

          COUNT(DISTINCT CASE
            WHEN ($2::text[] IS NULL OR o.application_status::text = ANY($2::text[]))
              AND o.application_status::text = 'APPLICATION_REJECTED'
            THEN o.application_id END)::int AS application_reject,

          COUNT(DISTINCT CASE
            WHEN ($2::text[] IS NULL OR o.application_status::text = ANY($2::text[]))
              AND o.application_status::text = ANY($4::text[])
            THEN o.application_id END)::int AS application_pending

         FROM organisation o
         INNER JOIN dbrap_lgd_block lb    ON lb.block_code::text = o.block_code::text
         INNER JOIN dbrap_division dv     ON dv.division_code::text = lb.division_code::text
         INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        WHERE o.block_code::text = $1::text
          AND dd.circle_code::text = ANY($5::text[])
          AND ($2::text[] IS NULL OR o.application_status::text = ANY($2::text[]))
        GROUP BY COALESCE(o.gram_panchayat_code::text, o.gram_panchayat), o.gram_panchayat
        ORDER BY o.gram_panchayat ASC`,
      [
        blockCode,
        applicationStatuses.length ? applicationStatuses : null, // $2 — optional status pre-filter
        APPROVED_STATUSES,                                        // $3
        PENDING_STATUSES,                                         // $4
        officer.circleCodes,                                      // $5
      ]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardPanchayatReport error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─── Applications list (updated: now accepts gramPanchayatCode filter) ─────────

const getCEDashboardBlockApplications = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const blockCode = String(req.query.blockCode || "").trim();
    if (!blockCode) return res.status(400).json({ error: "Block code is required" });

    const applicationStatuses   = parseApplicationStatusFilter(req.query.application_status);

    // Optional panchayat filter — sent by the frontend when drilling from panchayat row
    const gramPanchayatCode = String(req.query.gramPanchayatCode || "").trim() || null;

    const result = await pool.query(
      `SELECT
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
         INNER JOIN dbrap_lgd_block lb    ON lb.block_code::text = o.block_code::text
         INNER JOIN dbrap_division dv     ON dv.division_code::text = lb.division_code::text
         INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        WHERE o.block_code::text = $1::text
          AND dd.circle_code::text = ANY($2::text[])
          AND ($3::text[] IS NULL OR o.application_status::text = ANY($3::text[]))
          -- Panchayat filter: match on code when stored, otherwise match on name
          AND (
            $4::text IS NULL
            OR COALESCE(o.gram_panchayat_code::text, o.gram_panchayat) = $4::text
          )
        ORDER BY o.created_at DESC`,
      [
        blockCode,
        officer.circleCodes,
        applicationStatuses.length ? applicationStatuses : null,
        gramPanchayatCode,
      ]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardBlockApplications error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  getCEDashboardApplicationSummary,
  getCEDashboardCircleReport,
  getCEDashboardDivisionReport,
  getCEDashboardBlockReport,
  getCEDashboardPanchayatReport, // ← NEW export
  getCEDashboardBlockApplications,
};
