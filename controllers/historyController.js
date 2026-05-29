const pool = require("../db/db");

/**
 * Parse browser name and version from a User-Agent string
 */
const parseUserAgent = (ua) => {
  if (!ua) return "Unknown";
  
  const uaString = String(ua).trim();

  // Edge (Edg)
  const edgeMatch = uaString.match(/(?:Edge|Edg|EdgiOS|EdgeA)\/([0-9._]+)/);
  if (edgeMatch) return `Edge ${edgeMatch[1]}`;

  // Opera (OPR)
  const operaMatch = uaString.match(/(?:Opera|OPR)\/([0-9._]+)/);
  if (operaMatch) return `Opera ${operaMatch[1]}`;

  // Brave
  const braveMatch = uaString.match(/Brave\/([0-9._]+)/);
  if (braveMatch) return `Brave ${braveMatch[1]}`;

  if (/Brave/i.test(uaString)) {
    const chromeMatch = uaString.match(/Chrome\/([0-9._]+)/);
    return `Brave ${chromeMatch ? chromeMatch[1] : ""}`.trim();
  }

  // Chrome
  const chromeMatch = uaString.match(/Chrome\/([0-9._]+)/);
  if (chromeMatch) return `Chrome ${chromeMatch[1]}`;

  // Safari
  const safariMatch = uaString.match(/Version\/([0-9._]+).*Safari/);
  if (safariMatch) return `Safari ${safariMatch[1]}`;

  // Firefox
  const firefoxMatch = uaString.match(/Firefox\/([0-9._]+)/);
  if (firefoxMatch) return `Firefox ${firefoxMatch[1]}`;

  // Internet Explorer
  const ieMatch = uaString.match(/(?:MSIE |Trident\/.*; rv:)([0-9._]+)/);
  if (ieMatch) return `IE ${ieMatch[1]}`;

  // Fallback to first matched word/version
  const generalMatch = uaString.match(/^([A-Za-z0-9.]+)/);
  if (generalMatch) return generalMatch[1];

  return "Unknown";
};

/**
 * Save login history when a user (officer or applicant) logs in
 */
const saveLoginHistory = async (userId, loginId, userName, ipAddress, userAgent, loginStatus, sessionId = null, isActive = true) => {
  try {
    const parsedBrowser = parseUserAgent(userAgent);
    await pool.query(
      `
        INSERT INTO login_history (
          user_id, login_id, user_name, ip_address, user_agent, login_status, session_id, is_active, login_time, last_activity
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      `,
      [
        userId || null,
        loginId || null,
        userName || null,
        ipAddress || null,
        parsedBrowser,
        loginStatus,
        sessionId || null,
        isActive
      ]
    );
    return true;
  } catch (error) {
    console.error("Error saving login history:", error);
    return false;
  }
};

/**
 * Save application status change history
 *
 * Table columns expected:
 *   application_id  — which application changed
 *   action_type     — the new APPLICATION_STATUS value
 *   action_by       — ID of the user who performed the action
 *   remarks         — optional free-text remarks
 *   action_at       — timestamp (set to NOW())
 *
 * @param {string} applicationId
 * @param {string} userId        - ID of the user performing the action
 * @param {string} userName      - Name of the user (not stored — kept for caller convenience)
 * @param {string} actionType    - New APPLICATION_STATUS value
 * @param {string} oldValue      - Previous status (not stored unless you add the column)
 * @param {string} newValue      - New status (same as actionType — not stored separately unless you add the column)
 * @param {string} remarks       - Optional remarks
 */
const saveApplicationHistory = async (
  applicationId,
  userId,
  userName,      // retained in signature so existing callers don't break
  actionType,
  oldValue,      // retained in signature — add old_value column to table if you need it
  newValue,      // retained in signature — add new_value column to table if you need it
  remarks,
  queryRunner = pool
) => {
  try {
    await queryRunner.query(
      `
        INSERT INTO application_history (
          application_id,
          action_type,
          action_by,
          remarks,
          action_at
        )
        VALUES ($1, $2, $3, $4, NOW())
      `,
      [
        applicationId || null,   // $1 → application_id
        actionType    || null,   // $2 → action_type
        userId        || null,   // $3 → action_by  (the ID of who did the action)
        remarks       || null,   // $4 → remarks
      ]
    );
    return true;
  } catch (error) {
    console.error("Error saving application history:", error);
    return false;
  }
};

/**
 * Get login history by user ID
 */
const getLoginHistoryByUser = async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const result = await pool.query(
      `
        SELECT
          id, user_id, login_id, ip_address, user_agent, login_status, login_time
        FROM login_history
        WHERE user_id = $1
        ORDER BY login_time DESC
        LIMIT 100
      `,
      [userId]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching login history:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

/**
 * Get application history by application ID
 */
const getApplicationHistoryByApplication = async (req, res) => {
  try {
    const applicationId = String(req.params.applicationId || "").trim();

    if (!applicationId) {
      return res.status(400).json({ error: "Application ID is required" });
    }

    const result = await pool.query(
      `
        SELECT
          id, application_id, action_by, action_type, remarks, action_at
        FROM application_history
        WHERE application_id = $1
        ORDER BY action_at ASC
      `,
      [applicationId]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching application history:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  saveLoginHistory,
  saveApplicationHistory,
  getLoginHistoryByUser,
  getApplicationHistoryByApplication,
};
