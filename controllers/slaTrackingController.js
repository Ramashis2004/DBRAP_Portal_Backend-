const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");

const SLA_STAGE_STATUS_OPEN_MAP = Object.freeze({
  [APPLICATION_STATUS.APPLICATION_SUBMITTED]: "FORWARD_TO_JE",
  [APPLICATION_STATUS.APPLICATION_FORWARDED_TO_JE]: "SITE_INSPECTION_BY_JE",
  //[APPLICATION_STATUS.APPLICATION_FORWARDED_TO_JE]: "SITE_VISIT_REPORT_UPLOAD_BY_JE",
  [APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED]: "APPROVAL_BY_SE",
  [APPLICATION_STATUS.APPLICATION_APPROVED]: "PAYMENT_BY_USER",
  [APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED]: "PAYMENT_VERIFICATION_BY_JE",
  [APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED]: "CONNECTION_DETAIL_UPDATE_BY_JE",
});

const SLA_STAGE_STATUS_CLOSE_MAP = Object.freeze({
  [APPLICATION_STATUS.APPLICATION_FORWARDED_TO_JE]: "FORWARD_TO_JE",
  [APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED]: "SITE_INSPECTION_BY_JE",
  //[APPLICATION_STATUS.JE_VERIFIED_REPORT_UPLOADED]: "SITE_VISIT_REPORT_UPLOAD_BY_JE",
  [APPLICATION_STATUS.APPLICATION_APPROVED]: "APPROVAL_BY_SE",
  [APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED]: "PAYMENT_BY_USER",
  [APPLICATION_STATUS.PAYMENT_RECEIPT_VERIFIED]: "PAYMENT_VERIFICATION_BY_JE",
  [APPLICATION_STATUS.CONNECTION_DETAILS_UPDATED]: "CONNECTION_DETAIL_UPDATE_BY_JE",
});

const SLA_STAGE_ROLE_MAP = Object.freeze({
  FORWARD_TO_JE: "SE",
  SITE_INSPECTION_BY_JE: "JE",
  SITE_VISIT_REPORT_UPLOAD_BY_JE: "JE",
  APPROVAL_BY_SE: "SE",
  PAYMENT_BY_USER: "USER",
  PAYMENT_VERIFICATION_BY_JE: "JE",
  CONNECTION_DETAIL_UPDATE_BY_JE: "JE",
});

const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const computeCompletionStatus = (dueTime, completedTime) => {
  if (!dueTime || !completedTime) return "ON_TIME";
  return completedTime <= dueTime ? "ON_TIME" : "DELAYED";
};

const getDurationHoursForStage = async (client, stage) => {
  const result = await client.query(
    `
      SELECT duration_hours
      FROM sla_config
      WHERE stage = $1
        AND COALESCE(is_active, true) = true
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [stage]
  );

  const hours = Number(result.rows[0]?.duration_hours);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
};

const getOrganisationContext = async (client, applicationId) => {
  const result = await client.query(
    `
      SELECT applicant_user_id, block_code
      FROM organisation
      WHERE application_id = $1
      LIMIT 1
    `,
    [applicationId]
  );

  return result.rows[0] || null;
};

const getLoginIdByUserId = async (client, userId) => {
  const normalized = String(userId || "").trim();
  if (!normalized) return null;

  const result = await client.query(
    `SELECT login_id FROM user_master WHERE id = $1 LIMIT 1`,
    [normalized]
  );

  return result.rows[0]?.login_id || null;
};

const getAssignedJeLoginId = async (client, blockCode) => {
  const normalized = String(blockCode || "").trim();
  if (!normalized) return null;

  const result = await client.query(
    `
      SELECT login_id
      FROM user_master
      WHERE user_type_id = 4
        AND COALESCE(active_flag, 'Y') = 'Y'
        AND COALESCE(block_code::text, '') = $1
      ORDER BY id ASC
      LIMIT 1
    `,
    [normalized]
  );

  return result.rows[0]?.login_id || null;
};

const getAssignedSeLoginId = async (client, blockCode) => {
  const normalized = String(blockCode || "").trim();
  if (!normalized) return null;

  const result = await client.query(
    `
      SELECT um.login_id
      FROM dbrap_lgd_block lb
      INNER JOIN user_master um
        ON um.user_type_id = 2
       AND COALESCE(um.active_flag, 'Y') = 'Y'
       AND COALESCE(um.division_code::text, '') = COALESCE(lb.division_code::text, '')
      WHERE lb.block_code::text = $1
      ORDER BY um.id ASC
      LIMIT 1
    `,
    [normalized]
  );

  return result.rows[0]?.login_id || null;
};

const getAssignedToForStage = async (client, applicationId, stage, actorUserId, assignedTo) => {
  const role = SLA_STAGE_ROLE_MAP[String(stage || "").trim().toUpperCase()] || null;

  if (assignedTo) {
    return String(assignedTo).trim();
  }

  const ctx = await getOrganisationContext(client, applicationId);
  if (!ctx) return null;

  if (role === "USER") {
    return ctx.applicant_user_id ? await getLoginIdByUserId(client, ctx.applicant_user_id) : null;
  }

  if (role === "JE") {
    return ctx.block_code ? await getAssignedJeLoginId(client, ctx.block_code) : null;
  }

  if (role === "SE") {
    return ctx.block_code ? await getAssignedSeLoginId(client, ctx.block_code) : null;
  }

  return null;
};

const closeStageIfOpen = async (client, applicationId, stageToClose, completedTime) => {
  if (!stageToClose) return;

  await client.query(
    `
      WITH latest_open AS (
        SELECT id, due_time
        FROM sla_tracking
        WHERE application_id = $1
          AND stage = $2
          AND completed_time IS NULL
        ORDER BY start_time DESC
        LIMIT 1
      )
      UPDATE sla_tracking st
      SET
        completed_time = $3,
        status = CASE
          WHEN latest_open.due_time IS NULL THEN 'ON_TIME'
          WHEN $3 <= latest_open.due_time THEN 'ON_TIME'
          ELSE 'DELAYED'
        END
      FROM latest_open
      WHERE st.id = latest_open.id
    `,
    [applicationId, stageToClose, completedTime]
  );
};

const openStage = async (client, applicationId, stageToOpen, startTime, actorUserId, assignedTo) => {
  if (!stageToOpen) return;

  const durationHours = await getDurationHoursForStage(client, stageToOpen);
  const dueTime = durationHours
    ? new Date(startTime.getTime() + durationHours * 60 * 60 * 1000)
    : null;

  const assignedToValue = await getAssignedToForStage(
    client,
    applicationId,
    stageToOpen,
    actorUserId,
    assignedTo
  );

  await client.query(
    `
      INSERT INTO sla_tracking (
        application_id,
        stage,
        assigned_to,
        start_time,
        due_time,
        completed_time,
        status,
        escalation_level
      )
      VALUES ($1, $2, $3, $4, $5, NULL, 'ON_TIME', 0)
    `,
    [applicationId, stageToOpen, assignedToValue, startTime, dueTime]
  );
};

const handleSlaOnStatusChange = async ({
  applicationId,
  newStatus,
  actorUserId,
  assignedTo,
  eventTime,
}) => {
  const normalized = normalizeStatus(newStatus);
  const stageToClose = SLA_STAGE_STATUS_CLOSE_MAP[normalized] || null;
  const stageToOpen = SLA_STAGE_STATUS_OPEN_MAP[normalized] || null;

  if (!stageToClose && !stageToOpen) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const now = eventTime instanceof Date ? eventTime : new Date();

    if (stageToClose) {
      await closeStageIfOpen(client, applicationId, stageToClose, now);
    }

    if (stageToOpen) {
      await openStage(client, applicationId, stageToOpen, now, actorUserId, assignedTo);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const getSlaTrackingByApplication = async (req, res) => {
  try {
    const applicationId = String(req.params.applicationId || "").trim();

    if (!applicationId) {
      return res.status(400).json({ error: "applicationId is required" });
    }

    const result = await pool.query(
      `
        SELECT
          id,
          application_id,
          stage,
          assigned_to,
          start_time,
          due_time,
          completed_time,
          status,
          escalation_level
        FROM sla_tracking
        WHERE application_id = $1
        ORDER BY start_time ASC, id ASC
      `,
      [applicationId]
    );

    return res.status(200).json({ data: result.rows });
  } catch (error) {
    console.error("getSlaTrackingByApplication error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};
const handleSiteVisitUploadSla = async ({
  applicationId,
  inspectionDate,
  inspectionTime,
  actorUserId,
  assignedTo,
}) => {
  const inspectionCompletedAt = inspectionDate && inspectionTime
    ? new Date(`${inspectionDate}T${inspectionTime}:00`)
    : new Date();

  const now = new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: Close SITE_INSPECTION_BY_JE
    // completion_time = inspection date+time entered by JE
    await closeStageIfOpen(client, applicationId, "SITE_INSPECTION_BY_JE", inspectionCompletedAt);

    // Step 2: Insert SITE_VISIT_REPORT_UPLOAD_BY_JE
    // start_time = inspectionCompletedAt
    // due_time   = start_time + duration_hours from sla_config for this stage
    // completed_time = now (report uploaded right now)
    const siteVisitDurationHours = await getDurationHoursForStage(client, "SITE_VISIT_REPORT_UPLOAD_BY_JE");
    const siteVisitDueTime = siteVisitDurationHours
      ? new Date(inspectionCompletedAt.getTime() + siteVisitDurationHours * 60 * 60 * 1000)
      : null;

    const siteVisitAssignedTo = await getAssignedToForStage(
      client, applicationId, "SITE_VISIT_REPORT_UPLOAD_BY_JE", actorUserId, assignedTo
    );

    await client.query(
      `INSERT INTO sla_tracking
         (application_id, stage, assigned_to, start_time, due_time, completed_time, status, escalation_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [
        applicationId,
        "SITE_VISIT_REPORT_UPLOAD_BY_JE",
        siteVisitAssignedTo,
        inspectionCompletedAt,                                                          // start_time
        siteVisitDueTime,                                                               // start_time + duration_hours
        now,                                                                            // completed_time = upload time
        siteVisitDueTime
          ? (now <= siteVisitDueTime ? "ON_TIME" : "DELAYED")
          : "ON_TIME",
      ]
    );

    // Step 3: Insert APPROVAL_BY_SE
    // start_time = now (completion_time of SITE_VISIT_REPORT_UPLOAD_BY_JE)
    // due_time   = start_time + duration_hours from sla_config for this stage
    const approvalDurationHours = await getDurationHoursForStage(client, "APPROVAL_BY_SE");
    const approvalDueTime = approvalDurationHours
      ? new Date(now.getTime() + approvalDurationHours * 60 * 60 * 1000)               // start_time + duration_hours
      : null;

    const approvalAssignedTo = await getAssignedToForStage(
      client, applicationId, "APPROVAL_BY_SE", actorUserId, assignedTo
    );

    await client.query(
      `INSERT INTO sla_tracking
         (application_id, stage, assigned_to, start_time, due_time, completed_time, status, escalation_level)
       VALUES ($1, $2, $3, $4, $5, NULL, 'ON_TIME', 0)`,
      [
        applicationId,
        "APPROVAL_BY_SE",
        approvalAssignedTo,
        now,              // start_time = completion_time of SITE_VISIT_REPORT_UPLOAD_BY_JE
        approvalDueTime,  // start_time + duration_hours from sla_config
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
module.exports = {
  getSlaTrackingByApplication,
  handleSlaOnStatusChange,
  handleSiteVisitUploadSla,
};
