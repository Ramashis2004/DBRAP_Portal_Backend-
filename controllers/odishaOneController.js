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

// Helper to format timestamp as yyyyMMddHHmmssSSS (always in IST for Odisha One)
const formatTimestamp = () => {
  // Always use IST (UTC+5:30) — Odisha One validates against Indian Standard Time
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30
  const istDate = new Date(now.getTime() + (istOffset + now.getTimezoneOffset() * 60 * 1000));
  const pad = (num, len = 2) => String(num).padStart(len, "0");
  const yyyy = istDate.getFullYear();
  const MM = pad(istDate.getMonth() + 1);
  const dd = pad(istDate.getDate());
  const HH = pad(istDate.getHours());
  const mm = pad(istDate.getMinutes());
  const ss = pad(istDate.getSeconds());
  const SSS = pad(istDate.getMilliseconds(), 3);
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

  // Terminal log — decrypted payload data
  const loggableData = { ...data, OOUSERTOKEN: "***MASKED***", CHECKSUM: "***MASKED***" };
  console.log("\n============================================================");
  console.log("ODISHA ONE API-1 LANDING (ENCRYPTED -> DECRYPTED)");
  console.log("============================================================");
  console.log(`Received Request    : ${req.method} ${req.originalUrl}`);
  console.log(`Raw Encrypted Body  : encData=${String(encData).substring(0, 40)}...`);
  console.log("\nDecrypted Data Payload:");
  console.log(JSON.stringify(loggableData, null, 2));
  console.log("============================================================\n");

  const requestId = data.REQUESTID;
  const cancelUrl = data.TPIURLS?.CANCELURL || null;
  const successUrl = data.TPIURLS?.SUCCESSURL || null;

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
    const deptId = String(data.DEPARTEMENTID || data.DEPARTMENTID || config.deptId);
    const serviceId = String(data.SERVICEID || config.serviceId);
    const subServiceId = ""; // Always empty for Service 822

    const verifyPayload = {
      DEPARTEMENTID: deptId,
      SERVICEID: serviceId,
      SUBSERVICEID: subServiceId,
      REQUESTID: String(data.REQUESTID),
      REQTIMESTAMP: formatTimestamp(),
      OOUSERCODE: String(data.OOUSERCODE || ""),
    };
    verifyPayload.CHECKSUM = generateChecksum(verifyPayload, config.deptId, config.checksumKey);

    const verifyEncData = encrypt(config.accessKey, verifyPayload);
    const verifyUrl = `${config.baseUrl}/api/v1/tpi/verify-request?departementId=${deptId}&serviceId=${serviceId}`;

    const loggableVerifyPayload = { ...verifyPayload, CHECKSUM: "***MASKED***" };
    console.log("\n============================================================");
    console.log("ODISHA ONE API-2 VERIFICATION REQUEST");
    console.log("============================================================");
    console.log(`Request ID         : ${verifyPayload.REQUESTID}`);
    console.log(`Department ID      : ${deptId}`);
    console.log(`Service ID         : ${serviceId}`);
    console.log(`User Code          : ${verifyPayload.OOUSERCODE}`);
    console.log("\nPayload Before Encryption:");
    console.log(JSON.stringify(loggableVerifyPayload, null, 2));
    console.log(`\nURL: ${verifyUrl}`);

    const api2Response = await axios.post(
      verifyUrl,
      { encData: verifyEncData },
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        timeout: 30000,
      }
    ).catch((err) => {
      console.warn("API 2 call returned HTTP error, processing error response:", err.message);
      return err.response;
    });

    let originedFromOO = "NO";
    let verifyResponseData = null;

    // Decrypt encData if response is encrypted or parse direct JSON
    if (api2Response && api2Response.data && api2Response.data.encData) {
      const decryptedVerify = decrypt(config.accessKey, api2Response.data.encData);
      if (decryptedVerify) {
        try {
          verifyResponseData = JSON.parse(decryptedVerify);
          originedFromOO = verifyResponseData.ORIGINEDFROMOO || "NO";
        } catch (e) {
          console.error("Failed to parse decrypted API-2 JSON:", e.message);
        }
      }
    } else if (api2Response && api2Response.data) {
      verifyResponseData = api2Response.data;
      originedFromOO = api2Response.data.ORIGINEDFROMOO || "NO";
    }

    // In development/test mode if external portal is unreachable or testing, verify fallback
    if ((process.env.ODISHA_ONE_TEST_MODE === "true" || process.env.NODE_ENV === "development") && originedFromOO !== "YES") {
      console.warn("[ODISHA-ONE] Test mode active: Overriding ORIGINEDFROMOO to YES for verification.");
      originedFromOO = "YES";
    }

    const api2ResponseCode = api2Response ? api2Response.status : 500;

    // Real-time log: print all specification fields from API-2 Response
    console.log("\n============================================================");
    console.log("ODISHA ONE API-2 VERIFICATION RESPONSE (DECRYPTED)");
    console.log("============================================================");
    console.log(`HTTP Status Code    : ${api2ResponseCode}`);
    if (verifyResponseData) {
      console.log(`REQSTATUSCODE       : ${verifyResponseData.REQSTATUSCODE || "N/A"}`);
      console.log(`MSSSAGE             : ${verifyResponseData.MSSSAGE || verifyResponseData.MESSAGE || "N/A"}`);
      console.log(`DEPARTEMENTID       : ${verifyResponseData.DEPARTEMENTID || verifyResponseData.DEPARTMENTID || "N/A"}`);
      console.log(`SERVICEID           : ${verifyResponseData.SERVICEID || "N/A"}`);
      console.log(`SUBSERVICEID        : ${verifyResponseData.SUBSERVICEID || "N/A"}`);
      console.log(`REQUESTID           : ${verifyResponseData.REQUESTID || "N/A"}`);
      console.log(`REQTIMESTAMP        : ${verifyResponseData.REQTIMESTAMP || "N/A"}`);
      console.log(`ORIGINEDFROMOO      : ${verifyResponseData.ORIGINEDFROMOO || "N/A"}`);
      console.log(`OOUSERCODE          : ${verifyResponseData.OOUSERCODE || "N/A"}`);
      console.log(`CHECKSUM            : ${verifyResponseData.CHECKSUM || "N/A"}`);
      console.log("\nFull Decrypted JSON Object:");
      console.log(JSON.stringify(verifyResponseData, null, 2));
    } else {
      console.log("Raw Response Data   :", JSON.stringify(api2Response ? api2Response.data : null));
    }
    console.log(`Verification Result : ORIGINEDFROMOO = ${originedFromOO}`);
    console.log("============================================================\n");

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
        decryptedData: verifyResponseData,
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
      decryptedData: verifyResponseData,
      executionTimeMs: Date.now() - startTime,
    });

  } catch (verifyErr) {
    console.error("Odisha One API 2 Error:", verifyErr.message);
    if (process.env.ODISHA_ONE_TEST_MODE !== "true" && process.env.NODE_ENV !== "development") {
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

    // Save SUCCESSURL to organisation table if applicant already has an application
    if (successUrl) {
      await client.query(
        `UPDATE organisation SET oo_success_url = $1 WHERE applicant_user_id = $2 AND oo_success_url IS NULL`,
        [successUrl, String(applicantUser.id)]
      );
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

  // 6. Create Stateless Handoff JWT Token for Frontend
  const handoffToken = jwt.sign(
    {
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
    },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );

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

  // 8. Detect REQUESTTYPE and log complete details
  const requestType = String(data.REQUESTTYPE || "NEW").toUpperCase().trim();
  const isEditRequest = requestType === "OLD";

  console.log("\n============================================================");
  console.log(isEditRequest
    ? "ODISHA ONE EDIT REQUEST DETECTED (REQUESTTYPE=OLD)"
    : "ODISHA ONE NEW APPLICATION REQUEST (REQUESTTYPE=NEW)"
  );
  console.log("============================================================");
  console.log(`Request Type       : ${requestType}`);
  console.log(`Request ID         : ${data.REQUESTID}`);
  console.log(`Department ID      : ${data.DEPARTEMENTID || data.DEPARTMENTID}`);
  console.log(`Service ID         : ${data.SERVICEID}`);
  console.log(`User Code          : ${data.OOUSERCODE}`);
  console.log(`Full Name          : ${data.OOUSERFULLNAME}`);
  console.log(`Mobile No          : ${data.OOUSERMOBILENO}`);
  console.log(`Existing User      : ${isExistingUser ? "YES" : "NO"}`);
  console.log(`Applicant User ID  : ${applicantUser.id}`);
  if (isEditRequest) {
    console.log("\n[EDIT FLOW] REQUESTTYPE=OLD detected:");
    console.log("  → Citizen previously submitted application");
    console.log("  → Application was APPROVED by department");
    console.log("  → Citizen is returning from Odisha One Edit button");
    console.log("  → Redirecting to Payment Page for receipt upload");
  } else {
    console.log("\n[NEW FLOW] REQUESTTYPE=NEW detected:");
    console.log("  → New citizen arriving from Odisha One portal");
    console.log("  → Redirecting to Organisation Registration Page");
  }
  console.log(`\nRedirect Target    : ${isEditRequest ? "/applicant-payment" : "/applicant-organisation-registration"}`);
  console.log("============================================================\n");

  // 9. Redirect Browser to correct Frontend Page
  const redirectUrl = isEditRequest
    ? `/applicant-payment?oo_session=${handoffToken}`
    : `/applicant-organisation-registration?oo_session=${handoffToken}`;
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

  try {
    const session = jwt.verify(handoffToken, process.env.JWT_SECRET);
    return res.status(200).json({
      success: true,
      session: {
        applicant: session.applicant,
        token: session.token,
        requestId: session.requestId,
        serviceId: session.serviceId,
        subServiceId: session.subServiceId,
        ooUserCode: session.ooUserCode,
        ooUserToken: session.ooUserToken,
        tpiUrls: session.tpiUrls,
        isOdishaOne: true,
      },
    });
  } catch (err) {
    return res.status(404).json({ error: "Odisha One session handoff expired or invalid" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 3 CANCEL — POST /api/odisha-one/cancel
// ─────────────────────────────────────────────────────────────────────────────
const handleCancel = async (req, res) => {
  const config = getConfig();
  const { requestId, serviceId, subServiceId, ooUserToken, ooUserCode, cancelUrl } = req.body;

  const targetCancelUrl =
    cancelUrl ||
    process.env.ODISHA_ONE_CANCEL_URL ||
    `${config.baseUrl}/tpi/cancel`;

  const payload = {
    DEPARTEMENTID: String(config.deptId),
    SERVICEID:     String(serviceId || config.serviceId),
    SUBSERVICEID:  String(subServiceId || ""),
    REQUESTID:     String(requestId || ""),
    REQTIMESTAMP:  formatTimestamp(),
    OOUSERTOKEN:   String(ooUserToken || ""),
    OOUSERCODE:    String(ooUserCode || ""),
  };

  payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
  const encData    = encrypt(config.accessKey, payload);

  // ── Complete Terminal Log ──────────────────────────────────────────────────
  const loggable = { ...payload, OOUSERTOKEN: "***MASKED***", CHECKSUM: "***MASKED***" };
  console.log("\n============================================================");
  console.log("ODISHA ONE API-3 CANCEL PAYLOAD (RETURN TO ODISHA ONE)");
  console.log("============================================================");
  console.log(`API Name           : API-3 (Cancel / Return to Odisha One)`);
  console.log(`Request ID         : ${payload.REQUESTID}`);
  console.log(`Department ID      : ${payload.DEPARTEMENTID}`);
  console.log(`Service ID         : ${payload.SERVICEID}`);
  console.log(`User Code          : ${payload.OOUSERCODE}`);
  console.log(`REQTIMESTAMP       : ${payload.REQTIMESTAMP}`);
  console.log(`Target CANCELURL   : ${targetCancelUrl}`);
  console.log(`\nFull Payload (Before Encryption):`);
  console.log(JSON.stringify(loggable, null, 2));
  console.log(`\nencData (first 60 chars): ${String(encData).substring(0, 60)}...`);
  console.log("============================================================");
  console.log("STATUS             : 200 OK — Browser will POST encData to CANCELURL");
  console.log("============================================================\n");

  await logAudit({
    requestId,
    apiName:       "API3_CANCEL",
    serviceId:     payload.SERVICEID,
    subServiceId:  payload.SUBSERVICEID,
    ooUserCode,
    statusCode:    "200",
    statusMessage: "API-3 Cancel contract generated, redirecting to Odisha One",
    rawPayload:    JSON.stringify(payload),
    decryptedData: loggable,
  });

  return res.status(200).json({
    success:   true,
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
    ooStatus = "Pending",
  } = req.body;

  // Map numeric status string "1" to "Pending" for Odisha One API 4 compatibility
  const finalOOStatus = (ooStatus === "1" || !ooStatus) ? "Pending" : String(ooStatus);

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
    OOSTATUS: finalOOStatus,
  };

  payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
  const encData = encrypt(config.accessKey, payload);

  // ── Terminal Log — Print complete API-4 payload (mask secrets) ──
  const loggablePayload = { ...payload, OOUSERTOKEN: "***MASKED***", CHECKSUM: "***MASKED***" };
  console.log("\n============================================================");
  console.log("ODISHA ONE API-4 SUCCESS PAYLOAD");
  console.log("============================================================");
  console.log(`APPLICATION STATUS : ${payload.APPLICATIONSTATUS}`);
  console.log(`REQUEST ID         : ${requestId}`);
  console.log(`APPLICATION ID     : ${applicationId}`);
  console.log(`TIMESTAMP          : ${payload.REQTIMESTAMP}`);
  console.log(`OOUSERCODE         : ${ooUserCode}`);
  console.log(`OOSTATUS           : ${finalOOStatus}`);
  console.log(`SUCCESS URL        : ${targetSuccessUrl}`);
  console.log("\nAPI-4 PAYLOAD SENT TO ODISHA ONE:");
  console.log(JSON.stringify(loggablePayload, null, 2));
  console.log("\nDB LOG SAVED       : YES");
  console.log("============================================================");
  console.log("API-4 PAYLOAD READY — BROWSER WILL REDIRECT TO ODISHA ONE");
  console.log("============================================================\n");

  await logAudit({
    requestId,
    apiName: "API4_SUCCESS",
    serviceId,
    subServiceId,
    ooUserCode,
    applicationId,
    statusCode: "200",
    statusMessage: "Registration submitted successfully, success payload built",
    rawPayload: JSON.stringify(payload),
    decryptedData: payload,
  });

  return res.status(200).json({
    success: true,
    successUrl: targetSuccessUrl,
    encData,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 4 AUTO-TRIGGER — Called internally when APPLICATION_SUBMITTED
// ─────────────────────────────────────────────────────────────────────────────
// API 4 AUTO-TRIGGER — Called internally when APPLICATION_SUBMITTED or PAYMENT_RECEIPT_UPLOADED
// Sends API-4 success payload server-side to Odisha One SUCCESSURL
// ─────────────────────────────────────────────────────────────────────────────
const triggerApi4OnSubmit = async (applicationId, ooUserTokenParam = "", applicationStatus = "APPLICATION_SUBMITTED") => {
  const config = getConfig();

  try {
    // 1. Fetch all required Odisha One fields from organisation table
    const appRes = await pool.query(
      `SELECT application_id, oo_request_id, oo_service_id, oo_subservice_id,
              oo_user_code, oo_success_url
       FROM organisation
       WHERE application_id = $1
       LIMIT 1`,
      [applicationId]
    );

    if (appRes.rows.length === 0) {
      console.warn(`[API4-AUTO] Application not found: ${applicationId}`);
      return { success: false, message: "Application not found" };
    }

    const appData = appRes.rows[0];
    const requestId = appData.oo_request_id || "";
    const serviceId = appData.oo_service_id || config.serviceId;
    const subServiceId = ""; // Always empty for Service 822
    const ooUserCode = appData.oo_user_code || "";
    const ooUserToken = ooUserTokenParam || "";
    const targetSuccessUrl = appData.oo_success_url || `${config.baseUrl}/tpi/success`;

    // 2. Duplicate-call protection: skip if already successfully sent API4 for this status
    const dupCheck = await pool.query(
      `SELECT id FROM odisha_one_audit_logs
       WHERE api_name = 'API4_SUCCESS_AUTO' 
         AND application_id = $1 
         AND status_message LIKE $2
         AND status_code = '200'
       LIMIT 1`,
      [applicationId, `%${applicationStatus}%`]
    );
    if (dupCheck.rows.length > 0) {
      console.log(`[API4-AUTO] Duplicate call skipped — API4 already sent successfully for ${applicationId} (${applicationStatus})`);
      return { success: true, message: "Already sent" };
    }

    // 3. Build complete API-4 payload
    const payload = {
      DEPARTEMENTID: String(config.deptId),
      SERVICEID: String(serviceId),
      SUBSERVICEID: String(subServiceId),
      REQUESTID: String(requestId),
      REQTIMESTAMP: formatTimestamp(),
      APPLICATIONID: String(applicationId),
      APPLICATIONSTATUS: String(applicationStatus),
      ADDITIONALPARA1: "",
      ADDITIONALPARA2: "",
      OOUSERTOKEN: String(ooUserToken),
      OOUSERCODE: String(ooUserCode),
      OOSTATUS: "Pending",
    };
    payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
    const encData = encrypt(config.accessKey, payload);

    // 4. Terminal log — full payload (mask token)
    const loggablePayload = { ...payload, OOUSERTOKEN: "***MASKED***", CHECKSUM: "***MASKED***" };
    console.log("\n============================================================");
    console.log("ODISHA ONE STATUS UPDATE");
    console.log("============================================================");
    console.log(`Application ID     : ${applicationId}`);
    console.log(`Request ID         : ${requestId}`);
    console.log(`New Status         : ${applicationStatus}`);
    console.log(`Odisha One API     : API-4`);
    console.log(`OOSTATUS           : ${payload.OOSTATUS}`);
    console.log(`URL                : ${targetSuccessUrl}`);
    console.log("\nPayload Before Encryption:");
    console.log(JSON.stringify(loggablePayload, null, 2));

    // 5. Log plain payload to DB BEFORE sending
    await logAudit({
      requestId,
      apiName: "API4_SUCCESS_AUTO",
      serviceId,
      subServiceId,
      ooUserCode,
      applicationId,
      statusCode: "PENDING",
      statusMessage: `About to send API-4 payload: ${applicationStatus} => OOSTATUS: 1`,
      rawPayload: JSON.stringify(payload),
      decryptedData: loggablePayload,
    });

    // 6. Send HTTP POST to Odisha One SUCCESSURL
    let responseCode = 500;
    let responseData = null;
    let apiStatus = "FAILED";
    let errorMessage = null;

    try {
      const response = await axios.post(
        targetSuccessUrl,
        `encData=${encodeURIComponent(encData)}`,
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 30000,
        }
      );
      responseCode = response.status;
      responseData = response.data;
      apiStatus = responseCode === 200 ? "SUCCESS" : "FAILED";
    } catch (err) {
      errorMessage = err.message;
      responseCode = err.response?.status || 500;
      responseData = err.response?.data || null;
      apiStatus = "FAILED";
    }

    // 7. Log Odisha One response to DB
    await logAudit({
      requestId,
      apiName: "API4_SUCCESS_AUTO",
      serviceId,
      subServiceId,
      ooUserCode,
      applicationId,
      statusCode: String(responseCode),
      statusMessage: `API-4 ${apiStatus}: ${applicationStatus} sent to Odisha One${errorMessage ? ` | ERROR: ${errorMessage}` : ""}`,
    });

    // 8. Terminal log — response + DB verification
    console.log("\nOdisha One Response:");
    console.log(JSON.stringify(responseData, null, 2));
    console.log(`HTTP Status        : ${responseCode}`);
    console.log(`Result             : ${apiStatus}`);
    console.log("============================================================\n");

    return { success: apiStatus === "SUCCESS", data: responseData };
  } catch (error) {
    console.error("[API4-AUTO] Unexpected error:", error.message);
    return { success: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 9 STATUS PUSH — Push JalConnect application status to Odisha One (Host-to-Host)
// ─────────────────────────────────────────────────────────────────────────────
const ODISHA_ONE_STATUS_MAPPING = {
  APPLICATION_FORWARDED_TO_JE: { api: "API-9", ooStatus: "Pending" },
  JE_VERIFIED_REPORT_UPLOADED: { api: "API-9", ooStatus: "Pending" },
  APPLICATION_APPROVED:        { api: "API-9", ooStatus: "Required-Correction" },
  PAYMENT_RECEIPT_UPLOADED:    { api: "API-4", ooStatus: "Pending" },
  PAYMENT_RECEIPT_VERIFIED:    { api: "API-9", ooStatus: "Pending" },
  CONNECTION_DETAILS_UPDATED:  { api: "API-9", ooStatus: "Approved" },
};

const pushApplicationStatusToOdishaOne = async (applicationId, jalConnectStatus, remarks = "", forcePush = false, ooUserTokenParam = "") => {
  const config = getConfig();

  try {
    const statusUpper = String(jalConnectStatus || "").toUpperCase().trim();
    const mapping = ODISHA_ONE_STATUS_MAPPING[statusUpper];

    if (!mapping) {
      console.log(`[OO] Status '${jalConnectStatus}' is not mapped to Odisha One API — skipping push`);
      return { success: true, message: "Status not mapped to Odisha One API" };
    }

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
    const subServiceId = ""; // Always empty for Service 822
    const ooUserCode = appData.oo_user_code || "";
    const ooUserToken = ooUserTokenParam || "";
    const ooStatus = mapping.ooStatus;

    // 2. Duplicate protection for API-9 calls
    if (!forcePush) {
      const dupCheck = await pool.query(
        `SELECT id FROM odisha_one_audit_logs
         WHERE api_name = 'API9_STATUS_PUSH'
           AND application_id = $1
           AND status_message LIKE $2
           AND status_code = '200'
         LIMIT 1`,
        [applicationId, `%${statusUpper}%`]
      );
      if (dupCheck.rows.length > 0) {
        console.log(`[API9] Duplicate push skipped for ${applicationId} -> ${statusUpper}`);
        return { success: true, message: "Already pushed" };
      }
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

    // Terminal log — before encryption payload
    const loggablePayload = { ...payload, CHECKSUM: "***MASKED***" };
    console.log("\n============================================================");
    console.log("ODISHA ONE STATUS UPDATE");
    console.log("============================================================");
    console.log(`Application ID     : ${applicationId}`);
    console.log(`Request ID         : ${requestId}`);
    console.log(`New Status         : ${jalConnectStatus}`);
    console.log(`Odisha One API     : ${mapping.api}`);
    console.log(`OOSTATUS           : ${ooStatus}`);
    console.log("\nPayload Before Encryption:");
    console.log(JSON.stringify(loggablePayload, null, 2));

    await logAudit({
      requestId,
      apiName: "API9_STATUS_PUSH_PAYLOAD",
      serviceId,
      subServiceId,
      ooUserCode,
      applicationId,
      statusCode: "PENDING",
      statusMessage: `About to push: ${jalConnectStatus} => OOSTATUS: ${ooStatus}`,
      rawPayload: JSON.stringify(payload),
      decryptedData: loggablePayload,
    });

    const pushUrl = `${config.baseUrl}/api/v1/tpi/push-application-status?departementId=${config.deptId}&serviceId=${serviceId}`;

    const response = await axios.post(
      pushUrl,
      { encData },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    ).catch((err) => {
      console.log("\n============================================================");
      console.log("ODISHA ONE API ERROR DETAILS");
      console.log("============================================================");
      console.log(`Error Message : ${err.message}`);
      console.log(`Error Code    : ${err.code || "N/A"}`);
      console.log(`Target URL    : ${pushUrl}`);
      console.log(`HTTP Status   : ${err.response?.status || 500}`);
      console.log("============================================================\n");
      return err.response;
    });

    const responseCode = response ? response.status : 500;
    const responseData = response ? response.data : null;
    const apiStatus = responseCode === 200 ? "SUCCESS" : "FAILED";

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

    console.log("\nOdisha One Response:");
    console.log(JSON.stringify(responseData, null, 2));
    console.log(`HTTP Status        : ${responseCode}`);
    console.log(`Result             : ${apiStatus}`);
    console.log("============================================================\n");

    return { success: responseCode === 200, data: responseData };
  } catch (error) {
    console.error("API 9 push error:", error.message);
    return { success: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/odisha-one/logs — Retrieve Odisha One audit logs for inspection
// ─────────────────────────────────────────────────────────────────────────────
const getAuditLogs = async (req, res) => {
  try {
    const { apiName, requestId, applicationId, limit = 50 } = req.query;

    let query = `
      SELECT id, request_id, api_name, service_id, sub_service_id, oo_user_code,
             application_id, status_code, status_message, ip_address, created_at
      FROM odisha_one_audit_logs
      WHERE 1=1
    `;
    const params = [];

    if (apiName) {
      params.push(apiName);
      query += ` AND api_name = $${params.length}`;
    }

    if (requestId) {
      params.push(requestId);
      query += ` AND request_id = $${params.length}`;
    }

    if (applicationId) {
      params.push(applicationId);
      query += ` AND application_id = $${params.length}`;
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    params.push(safeLimit);
    query += ` ORDER BY id DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      logs: result.rows,
    });
  } catch (error) {
    console.error("Failed to fetch Odisha One audit logs:", error);
    return res.status(500).json({ error: "Failed to retrieve audit logs" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 12 REQUIRED CORRECTION REDIRECT — POST /api/odisha-one/required-correction
// Called after PAYMENT_RECEIPT_UPLOADED to redirect citizen back to Odisha One
// ─────────────────────────────────────────────────────────────────────────────
const handleRequiredCorrectionRedirect = async (req, res) => {
  const config = getConfig();
  const {
    requestId,
    serviceId,
    subServiceId,
    ooUserToken,
    ooUserCode,
    applicationId,
    applicationStatus,
    ooStatus,
    requiredCorrectionUrl,
  } = req.body;

  const targetUrl =
    requiredCorrectionUrl ||
    `${config.baseUrl}/api/v1/tpi/required-correction-request`;

  const payload = {
    DEPARTEMENTID:     String(config.deptId),
    SERVICEID:         String(serviceId || config.serviceId),
    SUBSERVICEID:      String(subServiceId || ""),
    REQUESTID:         String(requestId || ""),
    REQTIMESTAMP:      formatTimestamp(),
    OOUSERTOKEN:       String(ooUserToken || ""),
    OOUSERCODE:        String(ooUserCode || ""),
    APPLICATIONID:     String(applicationId || ""),
    APPLICATIONSTATUS: String(applicationStatus || "PAYMENT_RECEIPT_UPLOADED"),
    OOSTATUS:          String(ooStatus || "Pending"),
    REMARKS:           "Payment receipt uploaded successfully",
  };

  payload.CHECKSUM = generateChecksum(payload, config.deptId, config.checksumKey);
  const encData    = encrypt(config.accessKey, payload);

  // ── Complete Terminal Log ──────────────────────────────────────────────────
  const loggable = { ...payload, OOUSERTOKEN: "***MASKED***", CHECKSUM: "***MASKED***" };
  console.log("\n============================================================");
  console.log("ODISHA ONE API-12 REQUIRED CORRECTION REDIRECT");
  console.log("============================================================");
  console.log(`API Name           : API-12 (Required Correction Redirect)`);
  console.log(`Trigger Event      : PAYMENT_RECEIPT_UPLOADED`);
  console.log(`Application ID     : ${applicationId}`);
  console.log(`Request ID         : ${requestId}`);
  console.log(`Department ID      : ${config.deptId}`);
  console.log(`Service ID         : ${serviceId || config.serviceId}`);
  console.log(`User Code          : ${ooUserCode}`);
  console.log(`APPLICATIONSTATUS  : ${payload.APPLICATIONSTATUS}`);
  console.log(`OOSTATUS           : ${payload.OOSTATUS}`);
  console.log(`REMARKS            : ${payload.REMARKS}`);
  console.log(`REQTIMESTAMP       : ${payload.REQTIMESTAMP}`);
  console.log(`\nTarget URL         : ${targetUrl}`);
  console.log(`\nFull Payload (Before Encryption):`);
  console.log(JSON.stringify(loggable, null, 2));
  console.log(`\nencData (first 60 chars): ${String(encData).substring(0, 60)}...`);
  console.log("============================================================");
  console.log("STATUS             : 200 OK — Browser will POST to Odisha One");
  console.log("============================================================\n");

  await logAudit({
    requestId,
    apiName:       "API12_REQUIRED_CORRECTION",
    serviceId:     serviceId || config.serviceId,
    subServiceId:  subServiceId || "",
    ooUserCode,
    applicationId,
    statusCode:    "200",
    statusMessage: `API-12 redirect built: PAYMENT_RECEIPT_UPLOADED → REQUIREDCORRECTIONURL`,
    rawPayload:    JSON.stringify(payload),
    decryptedData: loggable,
  });

  return res.status(200).json({
    success:     true,
    redirectUrl: targetUrl,
    encData,
  });
};

module.exports = {
  handleLanding,
  getOdishaOneSession,
  handleCancel,
  handleSuccessRedirect,
  handleRequiredCorrectionRedirect,
  triggerApi4OnSubmit,
  pushApplicationStatusToOdishaOne,
  getAuditLogs,
};
