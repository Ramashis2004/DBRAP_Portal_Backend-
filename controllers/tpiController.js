const crypto = require("crypto");
const { encrypt, decrypt } = require("../utility/OdishaOneCryptoService");
const { generateChecksum, verifyChecksum } = require("../utility/OdishaOneChecksumService");
const {
  logAudit,
  saveTestRequest,
  getTestRequest,
  saveTestApplication,
  getTestApplication,
  updateTestApplicationStatus,
} = require("../services/tpiStore");

const getConfig = () => ({
  deptId: process.env.ODISHA_ONE_DEPARTMENT_ID,
  serviceId: process.env.ODISHA_ONE_SERVICE_ID,
  subServiceId: process.env.ODISHA_ONE_SUBSERVICE_ID,
  accessKey: process.env.ODISHA_ONE_ACCESS_KEY || process.env.ODISHA_ONE_ACCESS_CODE,
  checksumKey: process.env.ODISHA_ONE_CHECKSUM_KEY,
  baseUrl: process.env.ODISHA_ONE_BASE_URL,
});

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

// ─────────────────────────────────────────────────────────────────────────────
// POSTMAN HELPER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper Endpoint 1: Prepare Payload
 * Computes SHA-512 CHECKSUM and returns AES encrypted encData for Postman testing
 */
const preparePayload = async (req, res) => {
  try {
    const config = getConfig();
    const rawPayload = { ...req.body };

    // Set defaults if not provided
    if (!rawPayload.DEPARTEMENTID) rawPayload.DEPARTEMENTID = config.deptId;
    if (!rawPayload.SERVICEID) rawPayload.SERVICEID = config.serviceId;
    if (!rawPayload.SUBSERVICEID) rawPayload.SUBSERVICEID = config.subServiceId;
    if (!rawPayload.REQTIMESTAMP) rawPayload.REQTIMESTAMP = formatTimestamp();

    delete rawPayload.CHECKSUM;
    const checksum = generateChecksum(rawPayload, config.deptId, config.checksumKey);
    rawPayload.CHECKSUM = checksum;

    const encData = encrypt(config.accessKey, rawPayload);

    return res.status(200).json({
      success: true,
      message: "Payload encrypted successfully for Postman testing",
      checksum,
      encData,
      unencryptedPayload: rawPayload,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Helper Endpoint 2: Decrypt Payload
 * Decrypts encData string and returns the original JSON payload
 */
const decryptPayload = async (req, res) => {
  try {
    const config = getConfig();
    const encData = req.body?.encData || req.query?.encData || (typeof req.body === "string" ? req.body : null);

    if (!encData) {
      return res.status(400).json({ success: false, error: "encData is required" });
    }

    const decryptedStr = decrypt(config.accessKey, encData);
    if (!decryptedStr) {
      return res.status(307).json({ success: false, statusCode: "307", message: "INVALID_ENCRYPTED_DATA" });
    }

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(decryptedStr);
    } catch (e) {
      return res.status(311).json({ success: false, statusCode: "311", message: "INVALID_JSON_STRUCTURE", decryptedRaw: decryptedStr });
    }

    const isChecksumValid = verifyChecksum(parsedPayload, config.deptId, config.checksumKey, parsedPayload.CHECKSUM);

    return res.status(200).json({
      success: true,
      decryptedPayload: parsedPayload,
      checksumValid: isChecksumValid,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 1: PUSH API TO PUSH ENCRYPTED DATA (LANDING)
// ─────────────────────────────────────────────────────────────────────────────
const handleApi1Landing = async (req, res) => {
  const config = getConfig();
  const encData = req.body?.encData || req.query?.encData;

  if (!encData) {
    await logAudit({ apiName: "API1_LANDING", statusCode: "316", statusMessage: "EMPTY_ENC_DATA" });
    return res.status(400).json({
      REQSTATUSCODE: "316",
      MSSSAGE: "EMPTY_ENC_DATA",
      error: "Encrypted payload (encData) is missing.",
    });
  }

  const decryptedJson = decrypt(config.accessKey, encData);
  if (!decryptedJson) {
    await logAudit({ apiName: "API1_LANDING", statusCode: "307", statusMessage: "INVALID_ENCRYPTED_DATA" });
    return res.status(400).json({
      REQSTATUSCODE: "307",
      MSSSAGE: "INVALID_ENCRYPTED_DATA",
      error: "Unable to decrypt incoming payload using configured access key.",
    });
  }

  let data;
  try {
    data = JSON.parse(decryptedJson);
  } catch (err) {
    await logAudit({ apiName: "API1_LANDING", statusCode: "311", statusMessage: "INVALID_JSON_STRUCTURE" });
    return res.status(400).json({
      REQSTATUSCODE: "311",
      MSSSAGE: "INVALID_JSON_STRUCTURE",
      error: "Decrypted payload is not valid JSON format.",
    });
  }

  const requestId = data.REQUESTID;
  if (!requestId) {
    await logAudit({ apiName: "API1_LANDING", statusCode: "304", statusMessage: "INVALID_REQUEST_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "304",
      MSSSAGE: "INVALID_REQUEST_ID",
      error: "REQUESTID parameter is missing from request payload.",
    });
  }

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
      statusMessage: "INVALID_CHECKSUM",
    });
    return res.status(400).json({
      REQSTATUSCODE: "309",
      MSSSAGE: "INVALID_CHECKSUM",
      error: "Checksum verification failed. Hash string mismatch.",
    });
  }

  // Save in local test store
  saveTestRequest(requestId, data);

  await logAudit({
    requestId,
    apiName: "API1_LANDING",
    serviceId: data.SERVICEID,
    subServiceId: data.SUBSERVICEID,
    ooUserCode: data.OOUSERCODE,
    statusCode: "200",
    statusMessage: "HOST TO HOST SUCCESS - Request received & decrypted",
  });

  return res.status(200).json({
    REQSTATUSCODE: "200",
    MSSSAGE: "HOST TO HOST SUCCESS",
    REQUESTID: requestId,
    REQTIMESTAMP: formatTimestamp(),
    DEPARTEMENTID: data.DEPARTEMENTID,
    SERVICEID: data.SERVICEID,
    SUBSERVICEID: data.SUBSERVICEID,
    OOUSERCODE: data.OOUSERCODE,
    decryptedData: data,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 2: VERIFY REQUEST ORIGINATED AT ODISHA ONE
// ─────────────────────────────────────────────────────────────────────────────
const handleApi2VerifyRequest = async (req, res) => {
  const config = getConfig();
  const body = req.body || {};

  const deptId = req.query.departementId || req.query.departmentId || body.DEPARTEMENTID || config.deptId;
  const serviceId = req.query.serviceId || body.SERVICEID || config.serviceId;

  if (!body.REQUESTID) {
    await logAudit({ apiName: "API2_VERIFY", statusCode: "304", statusMessage: "INVALID_REQUEST_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "304",
      MSSSAGE: "INVALID_REQUEST_ID",
      DEPARTEMENTID: deptId,
      SERVICEID: serviceId,
      SUBSERVICEID: body.SUBSERVICEID || config.subServiceId,
      REQUESTID: "",
      REQTIMESTAMP: formatTimestamp(),
      ORIGINEDFROMOO: "NO",
      OOUSERCODE: body.OOUSERCODE || "",
      CHECKSUM: "",
    });
  }

  const receivedChecksum = body.CHECKSUM || "";
  const isChecksumValid = verifyChecksum(body, config.deptId, config.checksumKey, receivedChecksum);

  if (!isChecksumValid) {
    await logAudit({
      requestId: body.REQUESTID,
      apiName: "API2_VERIFY",
      serviceId,
      subServiceId: body.SUBSERVICEID,
      ooUserCode: body.OOUSERCODE,
      statusCode: "309",
      statusMessage: "INVALID_CHECKSUM",
    });

    const errRes = {
      REQSTATUSCODE: "309",
      MSSSAGE: "INVALID_CHECKSUM",
      DEPARTEMENTID: String(deptId),
      SERVICEID: String(serviceId),
      SUBSERVICEID: String(body.SUBSERVICEID || config.subServiceId),
      REQUESTID: String(body.REQUESTID),
      REQTIMESTAMP: formatTimestamp(),
      ORIGINEDFROMOO: "NO",
      OOUSERCODE: String(body.OOUSERCODE || ""),
    };
    errRes.CHECKSUM = generateChecksum(errRes, config.deptId, config.checksumKey);
    return res.status(400).json(errRes);
  }

  // Verification logic: check if request is in test store or valid format
  const storedReq = getTestRequest(body.REQUESTID);
  const originedFromOO = storedReq || process.env.ODISHA_ONE_TEST_MODE === "true" ? "YES" : "NO";

  const responsePayload = {
    REQSTATUSCODE: "200",
    MSSSAGE: "HOST TO HOST SUCCESS",
    DEPARTEMENTID: String(deptId),
    SERVICEID: String(serviceId),
    SUBSERVICEID: String(body.SUBSERVICEID || config.subServiceId),
    REQUESTID: String(body.REQUESTID),
    REQTIMESTAMP: formatTimestamp(),
    ORIGINEDFROMOO: originedFromOO,
    OOUSERCODE: String(body.OOUSERCODE || ""),
  };

  responsePayload.CHECKSUM = generateChecksum(responsePayload, config.deptId, config.checksumKey);

  await logAudit({
    requestId: body.REQUESTID,
    apiName: "API2_VERIFY",
    serviceId,
    subServiceId: body.SUBSERVICEID,
    ooUserCode: body.OOUSERCODE,
    statusCode: "200",
    statusMessage: `Verified origin: ORIGINEDFROMOO=${originedFromOO}`,
  });

  return res.status(200).json(responsePayload);
};

// ─────────────────────────────────────────────────────────────────────────────
// API 3: CANCEL API TO REDIRECT BACK ON ODISHA ONE PORTAL
// ─────────────────────────────────────────────────────────────────────────────
const handleApi3Cancel = async (req, res) => {
  const config = getConfig();
  const body = req.body || {};

  const deptId = req.query.departementId || req.query.departmentId || body.DEPARTEMENTID || config.deptId;
  const serviceId = req.query.serviceId || body.SERVICEID || config.serviceId;

  if (!body.REQUESTID) {
    await logAudit({ apiName: "API3_CANCEL", statusCode: "304", statusMessage: "INVALID_REQUEST_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "304",
      MSSSAGE: "INVALID_REQUEST_ID",
      error: "REQUESTID is required for cancel redirection.",
    });
  }

  const receivedChecksum = body.CHECKSUM || "";
  const isChecksumValid = verifyChecksum(body, config.deptId, config.checksumKey, receivedChecksum);

  if (!isChecksumValid) {
    await logAudit({
      requestId: body.REQUESTID,
      apiName: "API3_CANCEL",
      statusCode: "309",
      statusMessage: "INVALID_CHECKSUM",
    });
    return res.status(400).json({
      REQSTATUSCODE: "309",
      MSSSAGE: "INVALID_CHECKSUM",
      error: "Checksum verification failed.",
    });
  }

  const cancelPayload = {
    DEPARTEMENTID: String(deptId),
    SERVICEID: String(serviceId),
    SUBSERVICEID: String(body.SUBSERVICEID || config.subServiceId),
    REQUESTID: String(body.REQUESTID),
    REQTIMESTAMP: formatTimestamp(),
    OOUSERTOKEN: String(body.OOUSERTOKEN || ""),
    OOUSERCODE: String(body.OOUSERCODE || ""),
  };

  cancelPayload.CHECKSUM = generateChecksum(cancelPayload, config.deptId, config.checksumKey);
  const encData = encrypt(config.accessKey, cancelPayload);

  await logAudit({
    requestId: body.REQUESTID,
    apiName: "API3_CANCEL",
    serviceId,
    subServiceId: body.SUBSERVICEID,
    ooUserCode: body.OOUSERCODE,
    statusCode: "200",
    statusMessage: "Cancel contract generated successfully",
  });

  return res.status(200).json({
    REQSTATUSCODE: "200",
    MSSSAGE: "HOST TO HOST SUCCESS",
    REQUESTID: body.REQUESTID,
    CANCELURL: `${config.baseUrl}/tpi/cancel`,
    encData,
    cancelPayload,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 4: SUCCESS API (NO PAYMENT INVOLVED)
// ─────────────────────────────────────────────────────────────────────────────
const handleApi4Success = async (req, res) => {
  const config = getConfig();
  const body = req.body || {};

  const deptId = req.query.departementId || req.query.departmentId || body.DEPARTEMENTID || config.deptId;
  const serviceId = req.query.serviceId || body.SERVICEID || config.serviceId;

  if (!body.REQUESTID) {
    await logAudit({ apiName: "API4_SUCCESS", statusCode: "304", statusMessage: "INVALID_REQUEST_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "304",
      MSSSAGE: "INVALID_REQUEST_ID",
      error: "REQUESTID is required.",
    });
  }

  if (!body.APPLICATIONID) {
    await logAudit({ apiName: "API4_SUCCESS", statusCode: "310", statusMessage: "INVALID_APPLICATION_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "310",
      MSSSAGE: "INVALID_APPLICATION_ID",
      error: "APPLICATIONID is required.",
    });
  }

  const receivedChecksum = body.CHECKSUM || "";
  const isChecksumValid = verifyChecksum(body, config.deptId, config.checksumKey, receivedChecksum);

  if (!isChecksumValid) {
    await logAudit({
      requestId: body.REQUESTID,
      apiName: "API4_SUCCESS",
      statusCode: "309",
      statusMessage: "INVALID_CHECKSUM",
    });
    return res.status(400).json({
      REQSTATUSCODE: "309",
      MSSSAGE: "INVALID_CHECKSUM",
      error: "Checksum verification failed.",
    });
  }

  // Save application in test store
  saveTestApplication(body.APPLICATIONID, {
    requestId: body.REQUESTID,
    deptId,
    serviceId,
    subServiceId: body.SUBSERVICEID || config.subServiceId,
    applicationStatus: body.APPLICATIONSTATUS || "Received",
    ooStatus: body.OOSTATUS || "Pending",
    ooUserCode: body.OOUSERCODE || "",
    ooUserToken: body.OOUSERTOKEN || "",
  });

  const successPayload = {
    DEPARTEMENTID: String(deptId),
    SERVICEID: String(serviceId),
    SUBSERVICEID: String(body.SUBSERVICEID || config.subServiceId),
    REQUESTID: String(body.REQUESTID),
    REQTIMESTAMP: formatTimestamp(),
    APPLICATIONID: String(body.APPLICATIONID),
    APPLICATIONSTATUS: String(body.APPLICATIONSTATUS || "Received"),
    ADDITIONALPARA1: String(body.ADDITIONALPARA1 || ""),
    ADDITIONALPARA2: String(body.ADDITIONALPARA2 || ""),
    OOUSERTOKEN: String(body.OOUSERTOKEN || ""),
    OOUSERCODE: String(body.OOUSERCODE || ""),
    OOSTATUS: String(body.OOSTATUS || "Pending"),
  };

  successPayload.CHECKSUM = generateChecksum(successPayload, config.deptId, config.checksumKey);
  const encData = encrypt(config.accessKey, successPayload);

  await logAudit({
    requestId: body.REQUESTID,
    apiName: "API4_SUCCESS",
    serviceId,
    subServiceId: body.SUBSERVICEID,
    ooUserCode: body.OOUSERCODE,
    applicationId: body.APPLICATIONID,
    statusCode: "200",
    statusMessage: "Success contract generated successfully",
  });

  return res.status(200).json({
    REQSTATUSCODE: "200",
    MSSSAGE: "HOST TO HOST SUCCESS",
    REQUESTID: body.REQUESTID,
    APPLICATIONID: body.APPLICATIONID,
    SUCCESSURL: `${config.baseUrl}/tpi/success`,
    encData,
    successPayload,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// API 9: PUSH THIRD PARTY APPLICATION / PAYMENT STATUS TO ODISHA ONE
// ─────────────────────────────────────────────────────────────────────────────
const handleApi9PushApplicationStatus = async (req, res) => {
  const config = getConfig();
  const body = req.body || {};

  const deptId = req.query.departementId || req.query.departmentId || body.DEPARTEMENTID || config.deptId;
  const serviceId = req.query.serviceId || body.SERVICEID || config.serviceId;

  if (!body.REQUESTID) {
    await logAudit({ apiName: "API9_PUSH_STATUS", statusCode: "304", statusMessage: "INVALID_REQUEST_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "304",
      MSSSAGE: "INVALID_REQUEST_ID",
      error: "REQUESTID is required.",
    });
  }

  if (!body.APPLICATIONID) {
    await logAudit({ apiName: "API9_PUSH_STATUS", statusCode: "310", statusMessage: "INVALID_APPLICATION_ID" });
    return res.status(400).json({
      REQSTATUSCODE: "310",
      MSSSAGE: "INVALID_APPLICATION_ID",
      error: "APPLICATIONID is required.",
    });
  }

  // Validate OOSTATUS per PDF spec: Pending, Approved, Rejected, Required-Correction (or 1, 2, 3, 4)
  const validOOStatuses = ["Pending", "Approved", "Rejected", "Required-Correction", "1", "2", "3", "4"];
  const ooStatus = String(body.OOSTATUS || "").trim();

  if (!ooStatus || !validOOStatuses.includes(ooStatus)) {
    await logAudit({
      requestId: body.REQUESTID,
      apiName: "API9_PUSH_STATUS",
      applicationId: body.APPLICATIONID,
      statusCode: "320",
      statusMessage: "INVALID_OOSTATUS",
    });

    const errRes = {
      REQSTATUSCODE: "320",
      MSSSAGE: "INVALID_OOSTATUS",
      REQUESTID: String(body.REQUESTID),
      REQTIMESTAMP: formatTimestamp(),
      APPLICATIONID: String(body.APPLICATIONID),
    };
    errRes.CHECKSUM = generateChecksum(errRes, config.deptId, config.checksumKey);

    return res.status(400).json({
      ...errRes,
      error: "OOSTATUS must be one of: Pending, Approved, Rejected, Required-Correction",
    });
  }

  const receivedChecksum = body.CHECKSUM || "";
  const isChecksumValid = verifyChecksum(body, config.deptId, config.checksumKey, receivedChecksum);

  if (!isChecksumValid) {
    await logAudit({
      requestId: body.REQUESTID,
      apiName: "API9_PUSH_STATUS",
      applicationId: body.APPLICATIONID,
      statusCode: "309",
      statusMessage: "INVALID_CHECKSUM",
    });

    const errRes = {
      REQSTATUSCODE: "309",
      MSSSAGE: "INVALID_CHECKSUM",
      REQUESTID: String(body.REQUESTID),
      REQTIMESTAMP: formatTimestamp(),
      APPLICATIONID: String(body.APPLICATIONID),
    };
    errRes.CHECKSUM = generateChecksum(errRes, config.deptId, config.checksumKey);

    return res.status(400).json(errRes);
  }

  // Update in test store
  updateTestApplicationStatus(body.APPLICATIONID, body.APPLICATIONSTATUS, body.REMARKS, ooStatus);

  const responsePayload = {
    REQSTATUSCODE: "200",
    MSSSAGE: "HOST TO HOST SUCCESS",
    REQUESTID: String(body.REQUESTID),
    REQTIMESTAMP: formatTimestamp(),
    APPLICATIONID: String(body.APPLICATIONID),
  };

  responsePayload.CHECKSUM = generateChecksum(responsePayload, config.deptId, config.checksumKey);

  await logAudit({
    requestId: body.REQUESTID,
    apiName: "API9_PUSH_STATUS",
    serviceId,
    subServiceId: body.SUBSERVICEID,
    applicationId: body.APPLICATIONID,
    statusCode: "200",
    statusMessage: `Pushed status successfully: OOSTATUS=${ooStatus}`,
  });

  return res.status(200).json(responsePayload);
};

module.exports = {
  preparePayload,
  decryptPayload,
  handleApi1Landing,
  handleApi2VerifyRequest,
  handleApi3Cancel,
  handleApi4Success,
  handleApi9PushApplicationStatus,
};
