const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const pool = require("../db/db");
const { encrypt, decrypt } = require("../utility/OdishaOneCryptoService");
const { generateChecksum, verifyChecksum } = require("../utility/OdishaOneChecksumService");
const { saveLoginHistory } = require("./historyController");

const APPLICANT_ROLE_ID = "7";

// Server-side in-memory session handoff store for Odisha One landing requests
const odishaOneHandoffStore = new Map();

// Helper to format timestamp as yyyyMMddHHmmssSSS
const formatTimestamp = (date = new Date()) => {
  const pad = (num, len = 2) => String(num).padStart(len, "0");
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const SSS = pad(date.getMilliseconds(), 3);
  return `${yyyy}${MM}${dd}${HH}${mm}${ss}${SSS}`;
};

// Config helpers
const getConfig = () => ({
  baseUrl: process.env.ODISHA_ONE_BASE_URL || "https://odishaone.gov.in/odisha-one",
  deptId: process.env.ODISHA_ONE_DEPARTMENT_ID || "485937",
  serviceId: process.env.ODISHA_ONE_SERVICE_ID || "123",
  subServiceId: process.env.ODISHA_ONE_SUBSERVICE_ID || "456",
  serviceCode: process.env.ODISHA_ONE_SERVICE_CODE || "XXR77",
  accessKey: process.env.ODISHA_ONE_ACCESS_KEY || "1234567890abcdef",
  checksumKey: process.env.ODISHA_ONE_CHECKSUM_KEY || "JWLP9BSUXX7BSCO79LRMHVZQC9MFS2",
});

// Helper to log audit entries to database and console in real-time
const logAudit = async ({
  requestId,
  apiName,
  serviceId,
  subServiceId,
  ooUserCode,
  applicationId,
  statusCode,
  statusMessage,
  ipAddress,
  userAgent,
  rawPayload,
  decryptedData,
  executionTimeMs,
}) => {
  const timestamp = new Date().toISOString();
  console.log(
    `[ODISHA-ONE AUDIT] [${timestamp}] API: ${apiName || "N/A"} | REQ_ID: ${requestId || "N/A"} | STATUS: ${statusCode || "200"} | MSG: ${statusMessage || ""} | IP: ${ipAddress || "N/A"}`
  );

  try {
    await pool.query(
      `
        INSERT INTO odisha_one_audit_logs
        (request_id, api_name, service_id, sub_service_id, oo_user_code, application_id, status_code, status_message, ip_address, user_agent, raw_payload, decrypted_data, execution_time_ms, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      `,
      [
        requestId || null,
        apiName || null,
        serviceId || null,
        subServiceId || null,
        ooUserCode || null,
        applicationId || null,
        String(statusCode || "200"),
        statusMessage || null,
        ipAddress || null,
        userAgent || null,
        rawPayload || null,
        decryptedData ? JSON.stringify(decryptedData) : null,
        executionTimeMs || null,
      ]
    );
  } catch (err) {
    console.error("Failed to log Odisha One audit entry:", err.message);
  }
};

// Helper to render HTML auto-submitting POST form for redirects to Odisha One
const renderPostRedirect = (res, targetUrl, encData) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Redirecting to Odisha One...</title>
      </head>
      <body onload="document.forms['odishaone_form'].submit()">
        <div style="text-align: center; margin-top: 50px; font-family: sans-serif;">
          <h2>Redirecting to Odisha One Portal...</h2>
          <p>Please wait while we transfer you back safely.</p>
        </div>
        <form name="odishaone_form" action="${targetUrl}" method="POST">
          <input type="hidden" name="encData" value="${encData}" />
        </form>
      </body>
    </html>
  `;
  res.setHeader("Content-Type", "text/html");
  return res.status(200).send(html);
};

// Helper to render Odisha One error page
const renderErrorView = (res, { code, title, message, cancelUrl, encData }) => {
  if (cancelUrl && encData) {
    return renderPostRedirect(res, cancelUrl, encData);
  }
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Odisha One Integration Error</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f8fafc; color: #1e293b; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
          .error-card { background: #ffffff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 32px; max-width: 480px; width: 100%; text-align: center; border-top: 4px solid #ef4444; }
          h1 { color: #dc2626; font-size: 20px; margin-bottom: 12px; }
          p { color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
          .code { font-family: monospace; font-size: 12px; background: #f1f5f9; padding: 4px 8px; border-radius: 4px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="error-card">
          <h1>${title || "Authentication Failed"}</h1>
          <p>${message || "Unable to verify Odisha One request."}</p>
          <div class="code">Error Code: ${code || "500"}</div>
        </div>
      </body>
    </html>
  `;
  res.setHeader("Content-Type", "text/html");
  return res.status(Number(code) || 400).send(html);
};

// Helper to generate new applicant user ID
const generateApplicantUserId = async (client) => {
  const result = await client.query(`SELECT COALESCE(MAX(id::bigint), 0) + 1 AS next_id FROM user_master WHERE id ~ '^[0-9]+$'`);
  return String(result.rows[0]?.next_id || Date.now());
};

// ─────────────────────────────────────────────────────────────────────────────
// API 1 LANDING ENDPOINT — POST /api/odisha-one/landing
// ─────────────────────────────────────────────────────────────────────────────
const handleLanding = async (req, res) => {
  const startTime = Date.now();
  const config = getConfig();
  const encData = req.body?.encData || req.query?.encData;
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  if (!encData) {
    await logAudit({
      apiName: "API1_LANDING",
      statusCode: "400",
      statusMessage: "Missing encData parameter in request",
      ipAddress,
      userAgent,
      executionTimeMs: Date.now() - startTime,
    });

    return renderErrorView(res, {
      code: "400",
      title: "Bad Request",
      message: "Encrypted payload (encData) is missing in the request.",
    });
  }

  // 1. Decrypt encData
  const decryptedJson = decrypt(config.accessKey, encData);
  if (!decryptedJson) {
    await logAudit({
      apiName: "API1_LANDING",
      statusCode: "307",
      statusMessage: "Unable to decrypt encData payload with accessKey",
      ipAddress,
      userAgent,
      rawPayload: String(encData).substring(0, 200),
      executionTimeMs: Date.now() - startTime,
    });

    return renderErrorView(res, {
      code: "307",
      title: "Invalid Encrypted Data",
      message: "Unable to decrypt incoming payload from Odisha One.",
    });
  }

  let data;
  try {
    data = JSON.parse(decryptedJson);
  } catch (err) {
    await logAudit({
      apiName: "API1_LANDING",
      statusCode: "311",
      statusMessage: "Decrypted payload is not valid JSON",
      ipAddress,
      userAgent,
      rawPayload: String(encData).substring(0, 200),
      executionTimeMs: Date.now() - startTime,
    });

    return renderErrorView(res, {
      code: "311",
      title: "Invalid JSON Structure",
      message: "Decrypted payload is not valid JSON.",
    });
  }

  const requestId = data.REQUESTID;
  const cancelUrl = data.TPIURLS?.CANCELURL || null;

  if (!requestId) {
    await logAudit({
      requestId: null,
      apiName: "API1_LANDING",
      serviceId: data.SERVICEID,
      subServiceId: data.SUBSERVICEID,
      ooUserCode: data.OOUSERCODE,
      statusCode: "304",
      statusMessage: "REQUESTID missing in decrypted payload",
      ipAddress,
      userAgent,
      decryptedData: data,
      executionTimeMs: Date.now() - startTime,
    });

    return renderErrorView(res, {
      code: "304",
      title: "Missing Request ID",
      message: "REQUESTID is missing from Odisha One payload.",
    });
  }

  // 2. Verify SHA-512 Checksum
  const receivedChecksum = data.CHECKSUM || "";
  const isChecksumValid = verifyChecksum(data, config.deptId, config.checksumKey, receivedChecksum);

  if (!isChecksumValid) {
    await logAudit({
      requestId,
      apiName: "API1_LANDING",
      serviceId: data.SERVICEID,
      subServiceId: data.SUBSERVICEID,
      ooUserCode: data.OOUSERCODE,
      statusCode: "309",
      statusMessage: "Security checksum mismatch",
      ipAddress,
      userAgent,
      rawPayload: String(encData).substring(0, 200),
      decryptedData: data,
      executionTimeMs: Date.now() - startTime,
    });

    return renderErrorView(res, {
      code: "309",
      title: "Checksum Verification Failed",
      message: "Security checksum mismatch. Request data may have been altered or corrupted in transit.",
      cancelUrl,
    });
  }

  // 3. API 2: Verify Request Origin with Odisha One (Host-to-Host)
  try {
    const verifyPayload = {
      DEPARTEMENTID: String(data.DEPARTEMENTID || config.deptId),
      SERVICEID: String(data.SERVICEID || config.serviceId),
      SUBSERVICEID: String(data.SUBSERVICEID || config.subServiceId),
      REQUESTID: String(data.REQUESTID),
      REQTIMESTAMP: formatTimestamp(),
      OOUSERCODE: String(data.OOUSERCODE || ""),
    };
    verifyPayload.CHECKSUM = generateChecksum(verifyPayload, config.deptId, config.checksumKey);

    const verifyEncData = encrypt(config.accessKey, verifyPayload);
    const verifyUrl = `${config.baseUrl}/api/v1/tpi/verify-request?departementId=${config.deptId}&serviceId=${data.SERVICEID || config.serviceId}`;

    const api2Response = await axios.post(
      verifyUrl,
      { encData: verifyEncData },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    ).catch((err) => {
      console.warn("API 2 call returned HTTP error, processing error response:", err.message);
      return err.response;
    });

    let originedFromOO = "NO";
    if (api2Response && api2Response.data && api2Response.data.encData) {
      const decryptedVerify = decrypt(config.accessKey, api2Response.data.encData);
      if (decryptedVerify) {
        const verifyData = JSON.parse(decryptedVerify);
        originedFromOO = verifyData.ORIGINEDFROMOO || "NO";
      }
    } else if (api2Response && api2Response.data && api2Response.data.ORIGINEDFROMOO) {
      originedFromOO = api2Response.data.ORIGINEDFROMOO;
    }

    // In development/test mode if external portal is unreachable, verify fallback
    if (process.env.NODE_ENV === "development" && originedFromOO !== "YES") {
      console.warn("Development mode: Overriding ORIGINEDFROMOO to YES for testing.");
      originedFromOO = "YES";
    }

    if (originedFromOO !== "YES") {
      await logAudit({
        requestId,
        apiName: "API2_VERIFY",
        serviceId: data.SERVICEID,
        subServiceId: data.SUBSERVICEID,
        ooUserCode: data.OOUSERCODE,
        statusCode: "403",
        statusMessage: "ORIGINEDFROMOO verification failed",
        ipAddress,
        userAgent,
        executionTimeMs: Date.now() - startTime,
      });

      return renderErrorView(res, {
        code: "403",
        title: "Unauthorized Request Origin",
        message: "Origin verification failed. Request did not originate from Odisha One portal.",
        cancelUrl,
      });
    }

    await logAudit({
      requestId,
      apiName: "API2_VERIFY",
      serviceId: data.SERVICEID,
      subServiceId: data.SUBSERVICEID,
      ooUserCode: data.OOUSERCODE,
      statusCode: "200",
      statusMessage: "ORIGINEDFROMOO verified successfully",
      ipAddress,
      userAgent,
      executionTimeMs: Date.now() - startTime,
    });

  } catch (verifyErr) {
    console.error("Odisha One API 2 Error:", verifyErr.message);
    if (process.env.NODE_ENV !== "development") {
      return renderErrorView(res, {
        code: "500",
        title: "Origin Verification Error",
        message: "Unable to verify request origin with Odisha One server.",
        cancelUrl,
      });
    }
  }

  // 4. Authenticate / Register User in JalConnect Database
  const ooUserCode = String(data.OOUSERCODE || data.OOUSEREMAIL || "").trim();
  const ooEmail = String(data.OOUSEREMAIL || `${ooUserCode}@odishaone.gov.in`).trim();
  const ooMobile = String(data.OOUSERMOBILENO || "").trim().replace(/\D/g, "");
  const ooFullName = String(data.OOUSERFULLNAME || "Odisha One User").trim();
  const ooGender = String(data.OOUSERGENDER || "Male").trim();
  const ooOrganisationName = String(data.ADDITIONALPARA1 || "").trim();

  // Normalize gender code for user_master ('M', 'F', 'O')
  let genderCode = "M";
  if (/^f/i.test(ooGender) || ooGender === "Female") genderCode = "F";
  else if (/^o/i.test(ooGender) || ooGender === "Other") genderCode = "O";

  const client = await pool.connect();
  let applicantUser;
  let isExistingUser = false;

  try {
    await client.query("BEGIN");

    // Search user_master by oo_user_code or mobile_no
    const existingUserRes = await client.query(
      `
        SELECT id, user_name, organisation_name, login_id, email_id, mobile_no, role_id, user_type_id,
               oo_user_code
        FROM user_master
        WHERE (oo_user_code = $1 OR mobile_no = $2)
          AND role_id = $3
          AND COALESCE(active_flag, 'Y') = 'Y'
        ORDER BY id DESC
        LIMIT 1
      `,
      [ooUserCode, ooMobile, APPLICANT_ROLE_ID]
    );

    if (existingUserRes.rows.length > 0) {
      applicantUser = existingUserRes.rows[0];
      isExistingUser = true;
      // Update oo_user_code or organisation_name if provided from Odisha One
      await client.query(
        `
          UPDATE user_master
          SET oo_user_code = COALESCE(oo_user_code, $1),
              organisation_name = CASE WHEN $2 <> '' THEN $2 ELSE organisation_name END,
              registration_source = COALESCE(registration_source, 'ODISHA_ONE')
          WHERE id = $3
        `,
        [ooUserCode, ooOrganisationName, applicantUser.id]
      );
      if (ooOrganisationName) {
        applicantUser.organisation_name = ooOrganisationName;
      }
    } else {
      // First-time Odisha One user: Insert into user_master
      const newApplicantId = await generateApplicantUserId(client);
      const applicantTypeResult = await client.query(
        `SELECT id FROM user_type_master WHERE UPPER(type_name) = 'APPLICANT' LIMIT 1`
      );
      const applicantUserTypeId = applicantTypeResult.rows[0]?.id || null;

      const insertRes = await client.query(
        `
          INSERT INTO user_master (
            id, user_name, organisation_name, login_id, password, email_id, mobile_no,
            gender, active_flag, created_by, role_id, user_type_id,
            designation, passwordchange_flag, is_logged, oo_user_code, registration_source
          )
          VALUES (
            $1, $2, $3, $1, $4, $5, $6, $7, 'Y', $1, $8, $9, 'Applicant', 'Y', false, $10, 'ODISHA_ONE'
          )
          RETURNING id, user_name, organisation_name, login_id, email_id, mobile_no, role_id, user_type_id
        `,
        [
          newApplicantId,
          ooFullName,
          ooOrganisationName || ooFullName,
          "P@ssw0rd", // placeholder hashed password
          ooEmail,
          ooMobile,
          genderCode,
          APPLICANT_ROLE_ID,
          applicantUserTypeId,
          ooUserCode,
        ]
      );
      applicantUser = insertRes.rows[0];
    }

    await client.query("COMMIT");
  } catch (dbErr) {
    await client.query("ROLLBACK");
    console.error("Odisha One user registration error:", dbErr);

    await logAudit({
      requestId,
      apiName: "API1_LANDING",
      serviceId: data.SERVICEID,
      subServiceId: data.SUBSERVICEID,
      ooUserCode: data.OOUSERCODE,
      statusCode: "500",
      statusMessage: `User onboarding DB error: ${dbErr.message}`,
      ipAddress,
      userAgent,
      executionTimeMs: Date.now() - startTime,
    });

    return renderErrorView(res, {
      code: "500",
      title: "User Onboarding Error",
      message: "Failed to establish user account in database.",
      cancelUrl,
    });
  } finally {
    client.release();
  }

  // 5. Establish Session & JWT Token
  const sessionId = crypto.randomUUID();

  await saveLoginHistory(
    applicantUser.id,
    applicantUser.login_id || applicantUser.id,
    applicantUser.user_name,
    ipAddress,
    userAgent,
    "true",
    sessionId,
    true
  );

  const token = jwt.sign(
    {
      id: applicantUser.id,
      loginId: applicantUser.login_id || applicantUser.id,
      roleId: applicantUser.role_id,
      roleName: "Applicant",
      sessionId: sessionId,
      isOdishaOne: true,
    },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );

  // 6. Create Handoff Token for Frontend
  const handoffToken = crypto.randomBytes(24).toString("hex");
  odishaOneHandoffStore.set(handoffToken, {
    applicant: {
      id: applicantUser.id,
      name: applicantUser.user_name,
      organisationName: applicantUser.organisation_name || ooOrganisationName || "",
      email: applicantUser.email_id,
      mobileNo: applicantUser.mobile_no,
      gender: ooGender,
    },
    token: token,
    requestId: data.REQUESTID,
    serviceId: data.SERVICEID,
    subServiceId: data.SUBSERVICEID,
    ooUserCode: data.OOUSERCODE,
    ooUserToken: data.OOUSERTOKEN,
    tpiUrls: data.TPIURLS || {},
    isOdishaOne: true,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });

  // Cleanup expired handoff tokens
  setTimeout(() => {
    odishaOneHandoffStore.delete(handoffToken);
  }, 15 * 60 * 1000);

  // 7. Audit Log API 1 Final Success & Redirect
  await logAudit({
    requestId,
    apiName: "API1_LANDING",
    serviceId: data.SERVICEID,
    subServiceId: data.SUBSERVICEID,
    ooUserCode: data.OOUSERCODE,
    statusCode: "200",
    statusMessage: `API 1 success: User session established (Existing User: ${isExistingUser ? "YES" : "NO"})`,
    ipAddress,
    userAgent,
    decryptedData: data,
    executionTimeMs: Date.now() - startTime,
  });

  // 8. Redirect Browser to Frontend Page
  const redirectUrl = `/applicant-organisation-registration?oo_session=${handoffToken}`;
  return res.redirect(redirectUrl);
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/odisha-one/session — Retrieve handoff details for frontend
// ─────────────────────────────────────────────────────────────────────────────
const getOdishaOneSession = (req, res) => {
  const handoffToken = req.query.handoffToken || req.headers["x-oo-session"];
  if (!handoffToken) {
    return res.status(400).json({ error: "Missing handoffToken parameter" });
  }

  const session = odishaOneHandoffStore.get(handoffToken);
  if (!session || Date.now() > session.expiresAt) {
    odishaOneHandoffStore.delete(handoffToken);
    return res.status(404).json({ error: "Odisha One session handoff expired or invalid" });
  }

  return res.status(200).json({
    success: true,
    session: {
      applicant: session.applicant,
      token: session.token,
      requestId: session.requestId,
      serviceId: session.serviceId,
      subServiceId: session.subServiceId,
      ooUserCode: session.ooUserCode,
      tpiUrls: session.tpiUrls,
      isOdishaOne: true,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 3 CANCEL — POST /api/odisha-one/cancel
// ─────────────────────────────────────────────────────────────────────────────
const handleCancel = async (req, res) => {
  const config = getConfig();
  const { requestId, serviceId, subServiceId, ooUserToken, ooUserCode, cancelUrl } = req.body;

  const targetCancelUrl = cancelUrl || `${config.baseUrl}/tpi/cancel`;

  const payload = {
    DEPARTEMENTID: String(config.deptId),
    SERVICEID: String(serviceId || config.serviceId),
    SUBSERVICEID: String(subServiceId || config.subServiceId),
    REQUESTID: String(requestId || ""),
    REQTIMESTAMP: formatTimestamp(),
    OOUSERTOKEN: String(ooUserToken || ""),
    OOUSERCODE: String(ooUserCode || ""),
  };

  payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
  const encData = encrypt(config.accessKey, payload);

  await logAudit({
    requestId,
    apiName: "API3_CANCEL",
    serviceId,
    subServiceId,
    ooUserCode,
    statusCode: "200",
    statusMessage: "User cancelled application, redirecting to Odisha One",
  });

  if (req.accepts("html") && !req.xhr) {
    return renderPostRedirect(res, targetCancelUrl, encData);
  }

  return res.status(200).json({
    success: true,
    cancelUrl: targetCancelUrl,
    encData,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 4 SUCCESS — POST /api/odisha-one/success
// ─────────────────────────────────────────────────────────────────────────────
const handleSuccessRedirect = async (req, res) => {
  const config = getConfig();
  const {
    applicationId,
    requestId,
    serviceId,
    subServiceId,
    ooUserToken,
    ooUserCode,
    successUrl,
    applicationStatus = "Received",
    ooStatus = "1", // 1: Pending
  } = req.body;

  const targetSuccessUrl = successUrl || `${config.baseUrl}/tpi/success`;

  const payload = {
    DEPARTEMENTID: String(config.deptId),
    SERVICEID: String(serviceId || config.serviceId),
    SUBSERVICEID: String(subServiceId || config.subServiceId),
    REQUESTID: String(requestId || ""),
    REQTIMESTAMP: formatTimestamp(),
    APPLICATIONID: String(applicationId || ""),
    APPLICATIONSTATUS: String(applicationStatus),
    ADDITIONALPARA1: "",
    ADDITIONALPARA2: "",
    OOUSERTOKEN: String(ooUserToken || ""),
    OOUSERCODE: String(ooUserCode || ""),
    OOSTATUS: String(ooStatus),
  };

  payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
  const encData = encrypt(config.accessKey, payload);

  await logAudit({
    requestId,
    apiName: "API4_SUCCESS",
    serviceId,
    subServiceId,
    ooUserCode,
    applicationId,
    statusCode: "200",
    statusMessage: "Registration submitted successfully, success payload built",
  });

  return res.status(200).json({
    success: true,
    successUrl: targetSuccessUrl,
    encData,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 9 STATUS PUSH — Push JalConnect application status to Odisha One (Host-to-Host)
// ─────────────────────────────────────────────────────────────────────────────
const pushApplicationStatusToOdishaOne = async (applicationId, jalConnectStatus, remarks = "", forcePush = false) => {
  const config = getConfig();

  try {
    // 1. Fetch application and Odisha One metadata from organisation table
    const appRes = await pool.query(
      `
        SELECT application_id, oo_request_id, oo_service_id, oo_subservice_id, oo_user_code,
               registration_source, application_status
        FROM organisation
        WHERE application_id = $1
        LIMIT 1
      `,
      [applicationId]
    );

    if (appRes.rows.length === 0) return { success: false, message: "Application not found" };

    const appData = appRes.rows[0];
    const requestId = appData.oo_request_id || "";
    const serviceId = appData.oo_service_id || config.serviceId;
    const subServiceId = appData.oo_subservice_id || config.subServiceId;
    const ooUserCode = appData.oo_user_code || "";

    // Map JalConnect APPLICATION_STATUS to Odisha One OOSTATUS:
    // 1: Pending, 2: Approved, 3: Rejected, 4: Required-Correction
    let ooStatus = "1";
    const statusUpper = String(jalConnectStatus || "").toUpperCase();

    if (statusUpper === "APPLICATION_APPROVED") {
      ooStatus = "2";
    } else if (statusUpper === "APPLICATION_REJECTED") {
      ooStatus = "3";
    } else if (statusUpper === "APPLICATION_RETURNED_TO_APPLICANT") {
      ooStatus = "4";
    } else {
      ooStatus = "1"; // Default Pending for intermediate stages
    }

    const payload = {
      DEPARTEMENTID: String(config.deptId),
      SERVICEID: String(serviceId),
      SUBSERVICEID: String(subServiceId),
      REQUESTID: String(requestId),
      REQTIMESTAMP: formatTimestamp(),
      APPLICATIONID: String(applicationId),
      APPLICATIONSTATUS: String(jalConnectStatus),
      REMARKS: String(remarks || ""),
      ADDITIONALPARA1: "",
      ADDITIONALPARA2: "",
      OOSTATUS: String(ooStatus),
    };

    payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
    const encData = encrypt(config.accessKey, payload);

    const pushUrl = `${config.baseUrl}/api/v1/tpi/push-application-status?departementId=${config.deptId}&serviceId=${serviceId}`;

    const response = await axios.post(
      pushUrl,
      `encData=${encodeURIComponent(encData)}`,
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    ).catch((err) => {
      console.warn("API 9 Host-to-Host status push returned error:", err.message);
      return err.response;
    });

    const responseCode = response ? response.status : 500;
    const responseData = response ? response.data : null;

    await logAudit({
      requestId,
      apiName: "API9_STATUS_PUSH",
      serviceId,
      subServiceId,
      ooUserCode,
      applicationId,
      statusCode: String(responseCode),
      statusMessage: `Pushed status ${jalConnectStatus} (OOSTATUS: ${ooStatus})`,
    });

    return { success: responseCode === 200, data: responseData };
  } catch (error) {
    console.error("API 9 push error:", error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  handleLanding,
  getOdishaOneSession,
  handleCancel,
  handleSuccessRedirect,
  pushApplicationStatusToOdishaOne,
};
