const crypto = require("crypto");
const pool = require("../db/db");
const { saveLoginHistory } = require("./historyController");
const jwt = require("jsonwebtoken");


const USER_NAME_REGEX = /^[A-Za-z][A-Za-z\s.'-]{1,79}$/;
const DESIGNATION_REGEX = /^[A-Za-z0-9][A-Za-z0-9\s().,&/-]{1,79}$/;
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLICANT_ROLE_ID = "7";

const randomChar = (characters) => characters[Math.floor(Math.random() * characters.length)];
const PASSWORD_HASH_PREFIX = "";
const SMS_API_URL = process.env.SMS_API_URL || "https://govtsms.odisha.gov.in/api/api.php";
const SMS_DEPARTMENT_ID = process.env.SMS_DEPARTMENT_ID || "D047009";
const SMS_SOURCE = process.env.SMS_SOURCE || "ODIGOV";
const SMS_CREDENTIAL_TEMPLATE_ID = process.env.SMS_CREDENTIAL_TEMPLATE_ID || process.env.SMS_TEMPLATE_ID || "1007529288081313959";
const SMS_CREDENTIAL_ACTION = process.env.SMS_CREDENTIAL_ACTION || "sendOTPSMS";
const SMS_ENABLED = process.env.SMS_ENABLED !== "false";
const SMS_TIMEOUT_MS = Number(process.env.SMS_TIMEOUT_MS) || 100000;

const hashPassword = (plainPassword) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return `${PASSWORD_HASH_PREFIX}$${salt}$${derivedKey}`;
};

const verifyPassword = (plainPassword, storedPassword) => {
  if (!storedPassword) {
    return false;
  }

  if (!storedPassword.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
    return storedPassword === plainPassword;
  }

  const [, salt, storedHash] = storedPassword.split("$");

  if (!salt || !storedHash) {
    return false;
  }

  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(storedHash, "hex"), Buffer.from(derivedKey, "hex"));
};

const generatePassword = () => {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "@#$%&*!";
  const all = `${upper}${lower}${digits}${special}`;
  const passwordChars = [
    randomChar(upper),
    randomChar(lower),
    randomChar(digits),
    randomChar(special),
  ];

  while (passwordChars.length < 10) {
    passwordChars.push(randomChar(all));
  }

  for (let index = passwordChars.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [passwordChars[index], passwordChars[swapIndex]] = [passwordChars[swapIndex], passwordChars[index]];
  }

  return passwordChars.join("");
};

const escapeRegExp = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeCsvValues = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => String(item).trim())
    .filter(Boolean);
};

// ─── Division helpers (used for non-CE subtypes & fetchActiveSubTypes) ────────

const formatDivisionNames = (rows) =>
  rows
    .map((row) => String(row.division_name || row.division_code || "").trim())
    .filter(Boolean);

const getSubtypeDivisionCodes = (subTypeRow) => {
  const rawDivisionValue =
    subTypeRow?.division_codes ??
    subTypeRow?.division_code ??
    subTypeRow?.mapped_division_codes ??
    subTypeRow?.mapped_division_code ??
    subTypeRow?.division_mapping ??
    subTypeRow?.mapped_division ??
    "";

  return normalizeCsvValues(rawDivisionValue);
};

const getSubtypeDivisionNames = async (subTypeRow) => {
  const divisionCodes = getSubtypeDivisionCodes(subTypeRow);

  if (divisionCodes.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT division_code, division_name
      FROM dbrap_division
      WHERE division_code = ANY($1::text[])
      ORDER BY division_name ASC
    `,
    [divisionCodes]
  );

  return formatDivisionNames(result.rows);
};

// ─── Circle helpers (used for CE subtypes) ────────────────────────────────────

const formatCircleNames = (rows) =>
  rows
    .map((row) => String(row.circle_name || row.circle_code || "").trim())
    .filter(Boolean);

const getSubtypeCircleCodes = (subTypeRow) => {
  const rawCircleValue =
    subTypeRow?.circle_codes ??
    subTypeRow?.circle_code ??
    subTypeRow?.mapped_circle_codes ??
    subTypeRow?.mapped_circle_code ??
    subTypeRow?.circle_mapping ??
    subTypeRow?.mapped_circle ??
    "";

  return normalizeCsvValues(rawCircleValue);
};

const getSubtypeCircleNames = async (subTypeRow) => {
  const circleCodes = getSubtypeCircleCodes(subTypeRow);

  if (circleCodes.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT circle_code, circle_name
      FROM dbrap_circle
      WHERE circle_code = ANY($1::text[])
      ORDER BY circle_name ASC
    `,
    [circleCodes]
  );

  return formatCircleNames(result.rows);
};

// ─────────────────────────────────────────────────────────────────────────────

const getDivisionSerialForDistrict = async ({ districtCode, divisionCode }) => {
  const result = await pool.query(
    `
      SELECT division_code,
             ROW_NUMBER() OVER (ORDER BY division_code::text ASC) AS division_serial
      FROM dbrap_division
      WHERE dist_id = $1
        AND COALESCE(active_status, true) = true
      ORDER BY division_code::text ASC
    `,
    [String(districtCode || "").trim()]
  );

  const division = result.rows.find(
    (row) => String(row.division_code) === String(divisionCode || "").trim()
  );

  if (!division) {
    throw new Error("Unable to generate AEE login ID for the selected division");
  }

  return String(Number(division.division_serial)).padStart(2, "0");
};

const generateLoginId = async ({ userTypeName, districtCode, divisionCode, blockCode }) => {
  const normalizedUserTypeName = String(userTypeName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  let prefix = "";

  if (normalizedUserTypeName === "CE") {
    prefix = "CE";
  } else if (normalizedUserTypeName === "JE") {
    prefix = `JE${String(blockCode || "").trim()}`;
  } else if (normalizedUserTypeName === "AEE") {
    const divisionSerial = await getDivisionSerialForDistrict({ districtCode, divisionCode });
    prefix = `AEE${String(districtCode || "").trim()}${divisionSerial}`;
  } else {
    prefix = `${normalizedUserTypeName}${districtCode}`;
  }

  if (!prefix) {
    throw new Error("Unable to generate login ID prefix");
  }

  const existingLoginsResult = await pool.query(
    `
      SELECT login_id
      FROM user_master
      WHERE login_id LIKE $1
    `,
    [`${prefix}%`]
  );

  const maxSerial = existingLoginsResult.rows.reduce((currentMax, row) => {
    const match = row.login_id?.match(new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`));

    if (!match) {
      return currentMax;
    }

    return Math.max(currentMax, Number(match[1]));
  }, 0);

  return `${prefix}${String(maxSerial + 1).padStart(2, "0")}`;
};

const generateApplicantUserId = async (client) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["user_master_applicant_id"]);

  const serialResult = await client.query(
    `
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)),
        0
      ) AS last_serial
      FROM user_master
      WHERE id ~ '^USER[0-9]{5}$'
    `
  );

  const nextSerial = Number(serialResult.rows[0]?.last_serial || 0) + 1;
  return `USER${String(nextSerial).padStart(5, "0")}`;
};

const normalizeMobileNumber = (mobileNo) => String(mobileNo || "").trim().replace(/\D/g, "");

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`SMS service timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const sendCredentialsSms = async ({ mobileNo, loginId, password }) => {
  if (!SMS_ENABLED) {
    return "SMS sending is disabled by server configuration";
  }

  const normalizedMobileNo = normalizeMobileNumber(mobileNo);

  if (!MOBILE_REGEX.test(normalizedMobileNo)) {
    throw new Error("A valid 10-digit mobile number is required for SMS delivery");
  }

  const payload = new URLSearchParams({
    template_id: SMS_CREDENTIAL_TEMPLATE_ID,
    phonenumber: normalizedMobileNo,
    department_id: SMS_DEPARTMENT_ID,
    action: SMS_CREDENTIAL_ACTION,
    source: SMS_SOURCE,
    sms_content: `Your OTP for Gramsewa Nidhi Portal is ${password}. Please do not share this with anyone. Panchayati Raj & Drinking Water Dept. – Govt. of Odisha`,
  });

  let response;
  try {
    response = await fetchWithTimeout(SMS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    }, SMS_TIMEOUT_MS);
  } catch (error) {
    if (error.code === "UND_ERR_CONNECT_TIMEOUT") {
      throw new Error("SMS gateway could not be reached: connection timed out");
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`SMS service responded with status ${response.status}`);
  }

  const responseText = (await response.text()).trim();

  if (!responseText) {
    throw new Error("SMS service returned an empty response");
  }

  if (/error|fail|invalid|reject/i.test(responseText)) {
    throw new Error(`SMS service rejected the request: ${responseText}`);
  }

  return responseText;
};

const findApplicantByMobile = async (mobileNo, queryRunner = pool) => {
  const trimmedMobile = normalizeMobileNumber(mobileNo);

  if (!MOBILE_REGEX.test(trimmedMobile)) {
    return null;
  }

  const result = await queryRunner.query(
    `
      SELECT id
      FROM user_master
      WHERE mobile_no = $1
        AND role_id = $2
      LIMIT 1
    `,
    [trimmedMobile, APPLICANT_ROLE_ID]
  );

  return result.rows[0] || null;
};

const checkApplicantMobileAvailability = async (req, res) => {
  try {
    const mobileNo = req.query.mobile_number || req.body?.mobile_number;
    const trimmedMobile = normalizeMobileNumber(mobileNo);

    if (!MOBILE_REGEX.test(trimmedMobile)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
    }

    const existingApplicant = await findApplicantByMobile(trimmedMobile);

    return res.status(200).json({
      exists: Boolean(existingApplicant),
      message: existingApplicant ? "An applicant with this mobile number already exists" : "Mobile number is available",
    });
  } catch (error) {
    console.error("Applicant mobile check error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const fetchOfficerById = async (userId) => {
  const result = await pool.query(
    `
     SELECT
  um.id,
  um.user_name,
  um.login_id,
  um.email_id,
  um.mobile_no,
  um.role_id,
  um.user_type_id,
  um.active_flag,
  um.circle_code,
  um.district_code,
  um.division_code,
  um.block_code,
  COALESCE(utm.type_name, dr.role_name) AS role_name
FROM user_master um
LEFT JOIN user_type_master utm
 ON utm.id = um.user_type_id
LEFT JOIN dbrap_role dr
 ON dr.role_id::text = um.role_id
WHERE um.id = $1
LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

const fetchRoleNavigation = async (roleId) => {
  const result = await pool.query(
    `
      SELECT
        m.menu_id,
        m.menu_name,
        m.menu_description,
        m.menu_name_vernacular,
        m.menu_priority,
        rmm.serial_no,
        o.option_id,
        o.option_name,
        o.option_description,
        o.option_url,
        o.option_name_vernacular,
        o.priority AS option_priority
      FROM dbrap_role_menu_mapping rmm
      INNER JOIN dbrap_menu m ON m.menu_id = rmm.menu_id
      LEFT JOIN dbrap_role_options_mapping rom
        ON rom.role_id = rmm.role_id
       AND COALESCE(rom.status, true) = true
      LEFT JOIN dbrap_options o
        ON o.option_id = rom.option_id
       AND o.menu_id = m.menu_id
       AND COALESCE(o.status, true) = true
      WHERE rmm.role_id = $1
      ORDER BY
        COALESCE(rmm.serial_no, 999999),
        COALESCE(m.menu_priority, ''),
        COALESCE(o.priority, ''),
        COALESCE(o.option_name, '')
    `,
    [Number(roleId)]
  );

  const menuMap = new Map();

  for (const row of result.rows) {
    if (!menuMap.has(row.menu_id)) {
      menuMap.set(row.menu_id, {
        id: row.menu_id,
        key: `menu-${row.menu_id}`,
        label: row.menu_name,
        description: row.menu_description,
        vernacularLabel: row.menu_name_vernacular,
        priority: row.menu_priority,
        serialNo: row.serial_no,
        options: [],
      });
    }

    if (row.option_id) {
      menuMap.get(row.menu_id).options.push({
        id: row.option_id,
        key: `option-${row.option_id}`,
        label: row.option_name,
        description: row.option_description,
        url: row.option_url,
        vernacularLabel: row.option_name_vernacular,
        priority: row.option_priority,
      });
    }
  }

  return Array.from(menuMap.values());
};

const fetchUserCount = async () => {
  const result = await pool.query("SELECT COUNT(*)::int AS user_count FROM user_master");
  return result.rows[0]?.user_count || 0;
};

const fetchActiveUserTypes = async () => {
  const result = await pool.query(
    `
      SELECT id, type_name, is_active
      FROM user_type_master
      WHERE COALESCE(is_active, true) = true
      ORDER BY id
    `
  );

  return result.rows;
};

const fetchActiveSubTypes = async () => {
  const result = await pool.query(
    `
      SELECT *
      FROM sub_user_type_master
      WHERE COALESCE(is_active, true) = true
      ORDER BY id
    `
  );

  return Promise.all(
    result.rows.map(async (row) => ({
      ...row,
      // Division data (kept for non-CE use)
      division_codes: getSubtypeDivisionCodes(row),
      division_names: await getSubtypeDivisionNames(row),
      // Circle data (used for CE users)
      circle_codes: getSubtypeCircleCodes(row),
      circle_names: await getSubtypeCircleNames(row),
    }))
  );
};

const loginOfficer = async (req, res) => {
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;
  try {
    const { username, password, forceLogin = false } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const result = await pool.query(
      `
        SELECT
          um.id,
          um.user_name,
          um.login_id,
          um.password,
          um.email_id,
          um.mobile_no,
          um.role_id,
          um.user_type_id,
          um.active_flag,
          COALESCE(um.is_logged, false) AS is_logged,
          COALESCE(utm.type_name, dr.role_name) AS role_name
        FROM user_master um
        LEFT JOIN user_type_master utm ON utm.id = um.user_type_id
        LEFT JOIN dbrap_role dr ON dr.role_id::text = um.role_id
        WHERE um.login_id = $1
          AND COALESCE(um.active_flag, 'N') = 'Y'
        LIMIT 1
      `,
      [username.trim()]
    );

    if (result.rows.length === 0) {
      await saveLoginHistory(null, username.trim(), null, ipAddress, userAgent, "false", null, false);
      return res.status(401).json({ error: "Invalid officer credentials" });
    }

    const officer = result.rows[0];

    if (!verifyPassword(password, officer.password)) {
      await saveLoginHistory(officer.id, officer.login_id, officer.user_name, ipAddress, userAgent, "false", null, false);
      return res.status(401).json({ error: "Invalid officer credentials" });
    }

    if (officer.is_logged && !forceLogin) {
      return res.status(409).json({
        code: "ALREADY_LOGGED_IN",
        error: "This login ID is already logged in. Do you want to logout there and login here?",
      });
    }
// if (officer.is_logged && forceLogin) {
//   await pool.query(
//     `UPDATE user_master SET is_logged = false WHERE id = $1`,
//     [officer.id]
//   );
// }
    await pool.query(
      `
        UPDATE user_master
        SET is_logged = true
        WHERE id = $1
      `,
      [officer.id]
    );

    const sessionId = crypto.randomUUID();
    if (forceLogin) {
      await pool.query(
        `UPDATE login_history SET is_active = false, logout_time = NOW() WHERE user_id = $1 AND is_active = true`,
        [officer.id]
      );
    }
    await saveLoginHistory(officer.id, officer.login_id, officer.user_name, ipAddress, userAgent, "true", sessionId, true);

    const token = jwt.sign(
      { id: officer.id, loginId: officer.login_id, roleId: officer.role_id, roleName: officer.role_name, sessionId: sessionId },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: officer.id,
        name: officer.user_name,
        loginId: officer.login_id,
        email: officer.email_id,
        mobileNo: officer.mobile_no,
        roleId: officer.role_id,
        userTypeId: officer.user_type_id,
        roleName: officer.role_name,
      },
    });
  } catch (error) {
    console.error("Officer login error:", error);
    await saveLoginHistory(null, String(req.body?.username || "").trim() || null, null, ipAddress, userAgent, "false", null, false);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getOfficerDashboardConfig = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const officer = await fetchOfficerById(userId);

    if (!officer || officer.active_flag !== "Y") {
      return res.status(404).json({ error: "Officer not found or inactive" });
    }

    const menus = await fetchRoleNavigation(officer.role_id);

    if (menus.length === 0) {
      return res.status(404).json({ error: "No menu mapping found for this role" });
    }

    const totalOptions = menus.reduce((sum, menu) => sum + menu.options.length, 0);
    const userCount = await fetchUserCount();
    const userTypes = await fetchActiveUserTypes();
    const subTypes = await fetchActiveSubTypes();

    return res.status(200).json({
      user: {
  id: officer.id,
  name: officer.user_name,
  loginId: officer.login_id,
  email: officer.email_id,
  mobileNo: officer.mobile_no,
  roleId: officer.role_id,
  userTypeId: officer.user_type_id,
  roleName: officer.role_name,
  circle_code: officer.circle_code,
  district_code: officer.district_code,
  division_code: officer.division_code,
  block_code: officer.block_code
},
      dashboard: {
        navigation: {
          menus,
          defaultMenuKey: menus[0]?.key || null,
          defaultOptionKey: menus[0]?.options[0]?.key || null,
        },
        summary: {
          menuCount: menus.length,
          optionCount: totalOptions,
          roleName: officer.role_name,
          userCount,
        },
        masterData: {
          userTypes,
          subTypes,
        },
      },
    });
  } catch (error) {
    console.error("Dashboard config error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// const createOfficerUser = async (req, res) => {
//   try {
//     const {
//       userName,
//       emailId,
//       mobileNo,
//       userTypeId,
//       subTypeId,
//       createdBy,
//       designation,
//       circleCode,
//       districtCode,
//       divisionCode,
//       blockCode,
//     } = req.body;

//     if (!userTypeId || !userName || !designation || !mobileNo) {
//       return res.status(400).json({
//         error: "User type, name, designation, and mobile number are required",
//       });
//     }

//     const trimmedUserName = String(userName).trim();
//     const trimmedDesignation = String(designation).trim();
//     const trimmedMobileNo = String(mobileNo).trim();
//     const trimmedEmailId = emailId ? String(emailId).trim().toLowerCase() : "";
//     const normalizedCircleCode = String(circleCode || "").trim();
//     const normalizedDistrictCode = String(districtCode || "").trim();
//     const normalizedDivisionCode = String(divisionCode || "").trim();
//     const normalizedBlockCode = String(blockCode || "").trim();

//     if (!USER_NAME_REGEX.test(trimmedUserName)) {
//       return res.status(400).json({ error: "Name must be 2-80 characters and contain valid letters only" });
//     }

//     if (!DESIGNATION_REGEX.test(trimmedDesignation)) {
//       return res.status(400).json({ error: "Designation must be 2-80 characters and contain valid text" });
//     }

//     if (!MOBILE_REGEX.test(trimmedMobileNo)) {
//       return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
//     }

//     if (trimmedEmailId && !EMAIL_REGEX.test(trimmedEmailId)) {
//       return res.status(400).json({ error: "Please enter a valid email address" });
//     }

//     const userTypeResult = await pool.query(
//       `
//         SELECT id, type_name
//         FROM user_type_master
//         WHERE id = $1
//           AND COALESCE(is_active, true) = true
//         LIMIT 1
//       `,
//       [Number(userTypeId)]
//     );

//     if (userTypeResult.rows.length === 0) {
//       return res.status(400).json({ error: "Invalid user type selected" });
//     }

//     const selectedUserTypeName = String(userTypeResult.rows[0].type_name || "").trim().toUpperCase();
//     const requiresBlockSelection = selectedUserTypeName === "JE";
//     const requiresSubTypeSelection = selectedUserTypeName === "CE";
//     const isEicUserType = selectedUserTypeName === "EIC";
//     const requiresLocationSelection = !requiresSubTypeSelection && !isEicUserType;

//     if (requiresLocationSelection) {
//       if (!normalizedCircleCode || !normalizedDistrictCode || !normalizedDivisionCode) {
//         return res.status(400).json({
//           error: "Circle, district, and division are required for the selected user type",
//         });
//       }

//       const circleResult = await pool.query(
//         `
//           SELECT circle_code
//           FROM dbrap_circle
//           WHERE circle_code = $1
//             AND COALESCE(active_status, true) = true
//           LIMIT 1
//         `,
//         [normalizedCircleCode]
//       );

//       if (circleResult.rows.length === 0) {
//         return res.status(400).json({ error: "Invalid circle selected" });
//       }

//       const districtResult = await pool.query(
//         `
//           SELECT district_code
//           FROM dbrap_lgd_district
//           WHERE district_code = $1
//             AND circle_code = $2
//           LIMIT 1
//         `,
//         [normalizedDistrictCode, normalizedCircleCode]
//       );

//       if (districtResult.rows.length === 0) {
//         return res.status(400).json({ error: "Invalid district selected for the chosen circle" });
//       }
//     }

//     let generatedLoginId = "";
//     // For CE users: circle codes saved to circle_code column
//     let normalizedCircleCodeForInsert = normalizedCircleCode;
//     // For non-CE users: division codes saved normally
//     let normalizedDivisionCodeForInsert = normalizedDivisionCode;

//     if (requiresSubTypeSelection) {
//       // ── CE user flow: resolve circle mapping from subtype ──────────────────
//       if (!subTypeId) {
//         return res.status(400).json({ error: "Subtype is required for CE users" });
//       }

//       const subTypeResult = await pool.query(
//         `
//           SELECT
//             id,
//             sub_type_name,
//             type_id,
//             circle_code
//           FROM sub_user_type_master
//           WHERE id = $1
//             AND type_id = $2
//             AND COALESCE(is_active, true) = true
//           LIMIT 1
//         `,
//         [Number(subTypeId), Number(userTypeId)]
//       );

//       if (subTypeResult.rows.length === 0) {
//         return res.status(400).json({ error: "Invalid subtype selected for the chosen user type" });
//       }

//       generatedLoginId = String(subTypeResult.rows[0].sub_type_name || "").trim();

//       if (!generatedLoginId) {
//         return res.status(400).json({ error: "Invalid subtype selected for the chosen user type" });
//       }

//       const mappedCircleCodes = getSubtypeCircleCodes(subTypeResult.rows[0]);
//       const mappedCircleNames = await getSubtypeCircleNames(subTypeResult.rows[0]);

//       if (mappedCircleCodes.length === 0) {
//         return res.status(400).json({ error: "Circle mapping is not configured for the selected CE subtype" });
//       }

//       if (mappedCircleNames.length !== mappedCircleCodes.length) {
//         return res.status(400).json({
//           error: "One or more mapped circles are invalid or inactive",
//         });
//       }

//       // Save mapped circle codes (comma-separated) to circle_code column
//       normalizedCircleCodeForInsert = mappedCircleCodes.join(",");
//       // CE users have no division
//       normalizedDivisionCodeForInsert = null;
//     } else if (isEicUserType) {
//       // EIC users do not need circle, district, division, or block mapping.
//       generatedLoginId = selectedUserTypeName;
//     } else {
//       // ── Non-CE user flow: validate division (and optionally block) ─────────
//       const divisionResult = await pool.query(
//         `
//           SELECT d.division_code, d.dist_id AS district_code
//           FROM dbrap_division d
//           WHERE d.division_code = $1
//             AND d.dist_id = $2
//             AND COALESCE(d.active_status, true) = true
//           LIMIT 1
//         `,
//         [normalizedDivisionCode, normalizedDistrictCode]
//       );

//       if (divisionResult.rows.length === 0) {
//         return res.status(400).json({ error: "Invalid division selected for the chosen district" });
//       }

//       if (requiresBlockSelection) {
//         if (!normalizedBlockCode) {
//           return res.status(400).json({ error: "Block is required for JE users" });
//         }

//         const blockResult = await pool.query(
//           `
//             SELECT block_code, district_code
//             FROM dbrap_lgd_block
//             WHERE block_code = $1
//               AND division_code = $2
//               AND district_code = $3
//               AND COALESCE(active_status, true) = true
//             LIMIT 1
//           `,
//           [normalizedBlockCode, normalizedDivisionCode, normalizedDistrictCode]
//         );

//         if (blockResult.rows.length === 0) {
//           return res.status(400).json({ error: "Invalid block selected for the chosen division" });
//         }
//       }

//       generatedLoginId = await generateLoginId({
//         userTypeName: userTypeResult.rows[0].type_name,
//         districtCode: normalizedDistrictCode,
//         blockCode: normalizedBlockCode,
//       });
//     }

//     const generatedPassword = generatePassword();
//     const hashedPassword = hashPassword(generatedPassword);

//     const duplicateResult = await pool.query(
//       `
//         SELECT id
//         FROM user_master
//         WHERE login_id = $1
//            OR mobile_no = $2
//            OR ($3::varchar IS NOT NULL AND email_id = $3::varchar)
//         LIMIT 1
//       `,
//       [generatedLoginId, trimmedMobileNo, trimmedEmailId || null]
//     );

//     if (duplicateResult.rows.length > 0) {
//       return res.status(409).json({ error: "Login ID, mobile number, or email address already exists" });
//     }

//     const insertResult = await pool.query(
//       `
//         INSERT INTO user_master (
//           id,
//           user_name,
//           login_id,
//           password,
//           email_id,
//           mobile_no,
//           active_flag,
//           created_by,
//           role_id,
//           circle_code,
//           district_code,
//           division_code,
//           block_code,
//           user_type_id,
//           designation,
//           passwordchange_flag,
//           is_logged
//         )
//         VALUES (
//           nextval('user_master_seq')::text,
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'Y',
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12,
//           $13,
//           'N',
//           false
//         )
//         RETURNING id, user_name, login_id, email_id, mobile_no, role_id,
//                   circle_code, district_code, division_code, block_code,
//                   user_type_id, designation, created_on
//       `,
//       [
//         trimmedUserName,                                                      // $1
//         generatedLoginId,                                                     // $2
//         hashedPassword,                                                       // $3
//         trimmedEmailId || null,                                               // $4
//         trimmedMobileNo,                                                      // $5
//         createdBy || null,                                                    // $6
//         String(userTypeId),                                                   // $7  role_id
//         // $8 circle_code:
//         // CE  → mapped circle codes (comma-separated)
//         // non-CE → the circle the admin selected
//         requiresSubTypeSelection
//           ? normalizedCircleCodeForInsert
//           : requiresLocationSelection
//             ? normalizedCircleCode
//             : null,
//         // $9 district_code:
//         requiresLocationSelection ? normalizedDistrictCode : null,
//         // $10 division_code:
//         // CE  → null  (circles are stored instead)
//         // non-CE → the division the admin selected
//         requiresLocationSelection ? normalizedDivisionCodeForInsert : null,
//         // $11 block_code:
//         requiresBlockSelection ? normalizedBlockCode : null,
//         // $12 user_type_id:
//         Number(userTypeId),
//         // $13 designation:
//         trimmedDesignation,
//       ]
//     );

//     let smsSent = true;
//     let smsGatewayResponse = "";
//     let message = "User created successfully. Login ID and password sent to the user's mobile number.";

//     try {
//       smsGatewayResponse = await sendCredentialsSms({
//         mobileNo: trimmedMobileNo,
//         loginId: generatedLoginId,
//         password: generatedPassword,
//       });
//     } catch (smsError) {
//       smsSent = false;
//       message = "User created successfully, but sending credentials to the mobile number failed.";
//       console.error("Create officer user SMS error:", smsError);
//       smsGatewayResponse = smsError.message;
//     }

//     return res.status(201).json({
//       message,
//       smsSent,
//       smsGatewayResponse,
//       generatedCredentials: smsSent
//         ? null
//         : {
//             loginId: generatedLoginId,
//             password: generatedPassword,
//           },
//       user: insertResult.rows[0],
//     });
//   } catch (error) {
//     console.error("Create officer user error:", error);
//     return res.status(500).json({ error: "Server Error" });
//   }
// };

const createOfficerUser = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      userName,
      emailId,
      mobileNo,
      userTypeId,
      subTypeId,
      createdBy,
      designation,
      circleCode,
      districtCode,
      divisionCode,
      blockCode,
    } = req.body;

    if (!userTypeId || !userName || !designation || !mobileNo) {
      return res.status(400).json({
        error: "User type, name, designation, and mobile number are required",
      });
    }

    const trimmedUserName        = String(userName).trim();
    const trimmedDesignation     = String(designation).trim();
    const trimmedMobileNo        = String(mobileNo).trim();
    const trimmedEmailId         = emailId ? String(emailId).trim().toLowerCase() : "";
    const normalizedCircleCode   = String(circleCode   || "").trim();
    const normalizedDistrictCode = String(districtCode || "").trim();
    const normalizedDivisionCode = String(divisionCode || "").trim();
    const normalizedBlockCode    = String(blockCode    || "").trim();

    if (!USER_NAME_REGEX.test(trimmedUserName)) {
      return res.status(400).json({ error: "Name must be 2-80 characters and contain valid letters only" });
    }

    if (!DESIGNATION_REGEX.test(trimmedDesignation)) {
      return res.status(400).json({ error: "Designation must be 2-80 characters and contain valid text" });
    }

    if (!MOBILE_REGEX.test(trimmedMobileNo)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
    }

    if (trimmedEmailId && !EMAIL_REGEX.test(trimmedEmailId)) {
      return res.status(400).json({ error: "Please enter a valid email address" });
    }

    const userTypeResult = await pool.query(
      `
        SELECT id, type_name
        FROM user_type_master
        WHERE id = $1
          AND COALESCE(is_active, true) = true
        LIMIT 1
      `,
      [Number(userTypeId)]
    );

    if (userTypeResult.rows.length === 0) {
      return res.status(400).json({ error: "Invalid user type selected" });
    }

    const selectedUserTypeName    = String(userTypeResult.rows[0].type_name || "").trim().toUpperCase();
    const requiresBlockSelection  = selectedUserTypeName === "JE";
    const requiresSubTypeSelection = selectedUserTypeName === "CE";
    const isEicUserType           = selectedUserTypeName === "EIC";
    const requiresLocationSelection = !requiresSubTypeSelection && !isEicUserType;

    if (requiresLocationSelection) {
      if (!normalizedCircleCode || !normalizedDistrictCode || !normalizedDivisionCode) {
        return res.status(400).json({
          error: "Circle, district, and division are required for the selected user type",
        });
      }

      const circleResult = await pool.query(
        `
          SELECT circle_code
          FROM dbrap_circle
          WHERE circle_code = $1
            AND COALESCE(active_status, true) = true
          LIMIT 1
        `,
        [normalizedCircleCode]
      );

      if (circleResult.rows.length === 0) {
        return res.status(400).json({ error: "Invalid circle selected" });
      }

      const districtResult = await pool.query(
        `
          SELECT district_code
          FROM dbrap_lgd_district
          WHERE district_code = $1
            AND circle_code = $2
          LIMIT 1
        `,
        [normalizedDistrictCode, normalizedCircleCode]
      );

      if (districtResult.rows.length === 0) {
        return res.status(400).json({ error: "Invalid district selected for the chosen circle" });
      }
    }

    let generatedLoginId = "";
    let normalizedCircleCodeForInsert   = normalizedCircleCode;
    let normalizedDivisionCodeForInsert = normalizedDivisionCode;

    if (requiresSubTypeSelection) {
      if (!subTypeId) {
        return res.status(400).json({ error: "Subtype is required for CE users" });
      }

      const subTypeResult = await pool.query(
        `
          SELECT id, sub_type_name, type_id, circle_code
          FROM sub_user_type_master
          WHERE id = $1
            AND type_id = $2
            AND COALESCE(is_active, true) = true
          LIMIT 1
        `,
        [Number(subTypeId), Number(userTypeId)]
      );

      if (subTypeResult.rows.length === 0) {
        return res.status(400).json({ error: "Invalid subtype selected for the chosen user type" });
      }

      generatedLoginId = String(subTypeResult.rows[0].sub_type_name || "").trim();

      if (!generatedLoginId) {
        return res.status(400).json({ error: "Invalid subtype selected for the chosen user type" });
      }

      const mappedCircleCodes = getSubtypeCircleCodes(subTypeResult.rows[0]);
      const mappedCircleNames = await getSubtypeCircleNames(subTypeResult.rows[0]);

      if (mappedCircleCodes.length === 0) {
        return res.status(400).json({ error: "Circle mapping is not configured for the selected CE subtype" });
      }

      if (mappedCircleNames.length !== mappedCircleCodes.length) {
        return res.status(400).json({ error: "One or more mapped circles are invalid or inactive" });
      }

      normalizedCircleCodeForInsert   = mappedCircleCodes.join(",");
      normalizedDivisionCodeForInsert = null;

    } else if (isEicUserType) {
      generatedLoginId = selectedUserTypeName;

    } else {
      const divisionResult = await pool.query(
        `
          SELECT d.division_code, d.dist_id AS district_code
          FROM dbrap_division d
          WHERE d.division_code = $1
            AND d.dist_id = $2
            AND COALESCE(d.active_status, true) = true
          LIMIT 1
        `,
        [normalizedDivisionCode, normalizedDistrictCode]
      );

      if (divisionResult.rows.length === 0) {
        return res.status(400).json({ error: "Invalid division selected for the chosen district" });
      }

      if (requiresBlockSelection) {
        if (!normalizedBlockCode) {
          return res.status(400).json({ error: "Block is required for JE users" });
        }

        const blockResult = await pool.query(
          `
            SELECT block_code, district_code
            FROM dbrap_lgd_block
            WHERE block_code = $1
              AND division_code = $2
              AND district_code = $3
              AND COALESCE(active_status, true) = true
            LIMIT 1
          `,
          [normalizedBlockCode, normalizedDivisionCode, normalizedDistrictCode]
        );

        if (blockResult.rows.length === 0) {
          return res.status(400).json({ error: "Invalid block selected for the chosen division" });
        }
      }

      generatedLoginId = await generateLoginId({
        userTypeName: userTypeResult.rows[0].type_name,
        districtCode: normalizedDistrictCode,
        divisionCode: normalizedDivisionCode,
        blockCode: normalizedBlockCode,
      });
    }

    const generatedPassword = generatePassword();
    const hashedPassword    = hashPassword(generatedPassword);

    const duplicateResult = await pool.query(
      `
        SELECT id
        FROM user_master
        WHERE login_id = $1
           OR mobile_no = $2
           OR ($3::varchar IS NOT NULL AND email_id = $3::varchar)
        LIMIT 1
      `,
      [generatedLoginId, trimmedMobileNo, trimmedEmailId || null]
    );

    if (duplicateResult.rows.length > 0) {
      return res.status(409).json({ error: "Login ID, mobile number, or email address already exists" });
    }

    // ── Generate USER+5-digit serial ID (same format as applicants) ──────────
    // Advisory lock prevents two concurrent inserts racing on the serial.
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      ["user_master_officer_id"]
    );

    const serialResult = await client.query(
      `
        SELECT COALESCE(
          MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)),
          0
        ) AS last_serial
        FROM user_master
        WHERE id ~ '^USER[0-9]{5}$'
      `
    );

    const nextSerial    = Number(serialResult.rows[0]?.last_serial || 0) + 1;
    const generatedUserId = `USER${String(nextSerial).padStart(5, "0")}`;

    const insertResult = await client.query(
      `
        INSERT INTO user_master (
          id,
          user_name,
          login_id,
          password,
          email_id,
          mobile_no,
          active_flag,
          created_by,
          role_id,
          circle_code,
          district_code,
          division_code,
          block_code,
          user_type_id,
          designation,
          passwordchange_flag,
          is_logged
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          'Y', $7, $8, $9, $10, $11, $12, $13, $14,
          'N', false
        )
        RETURNING id, user_name, login_id, email_id, mobile_no, role_id,
                  circle_code, district_code, division_code, block_code,
                  user_type_id, designation, created_on
      `,
      [
        generatedUserId,                                                      // $1  id
        trimmedUserName,                                                      // $2  user_name
        generatedLoginId,                                                     // $3  login_id
        hashedPassword,                                                       // $4  password
        trimmedEmailId || null,                                               // $5  email_id
        trimmedMobileNo,                                                      // $6  mobile_no
        createdBy || null,                                                    // $7  created_by
        String(userTypeId),                                                   // $8  role_id
        // $9 circle_code
        requiresSubTypeSelection
          ? normalizedCircleCodeForInsert
          : requiresLocationSelection
            ? normalizedCircleCode
            : null,
        // $10 district_code
        requiresLocationSelection ? normalizedDistrictCode : null,
        // $11 division_code
        requiresLocationSelection ? normalizedDivisionCodeForInsert : null,
        // $12 block_code
        requiresBlockSelection ? normalizedBlockCode : null,
        // $13 user_type_id
        Number(userTypeId),
        // $14 designation
        trimmedDesignation,
      ]
    );

    await client.query("COMMIT");

    let smsSent = true;
    let smsGatewayResponse = "";
    let message = "User created successfully. Login ID and password sent to the user's mobile number.";

    try {
      smsGatewayResponse = await sendCredentialsSms({
        mobileNo: trimmedMobileNo,
        loginId:  generatedLoginId,
        password: generatedPassword,
      });
    } catch (smsError) {
      smsSent = false;
      message = "User created successfully, but sending credentials to the mobile number failed.";
      console.error("Create officer user SMS error:", smsError);
      smsGatewayResponse = smsError.message;
    }

    return res.status(201).json({
      message,
      smsSent,
      smsGatewayResponse,
      generatedCredentials: smsSent
        ? null
        : { loginId: generatedLoginId, password: generatedPassword },
      user: insertResult.rows[0],
    });

  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Create officer user error:", error);
    return res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

const registerApplicant = async (req, res) => {
  const client = await pool.connect();

  try {
    // AFTER:
const { name, organisation_name, gender, email, mobile_number } = req.body;
const trimmedName = String(name || "").trim();
const trimmedOrganisationName = String(organisation_name || "").trim();  // ← ADD
const trimmedGender = String(gender || "").trim();
const trimmedEmail = email ? String(email).trim().toLowerCase() : "";
const trimmedMobile = normalizeMobileNumber(mobile_number);

if (!trimmedName || !trimmedOrganisationName || !trimmedGender || !trimmedEmail || !trimmedMobile) {
  return res.status(400).json({ error: "Name, organisation name, gender, email, and mobile number are required" });
}

    if (!USER_NAME_REGEX.test(trimmedName)) {
      return res.status(400).json({ error: "Name must be 2-80 characters and contain valid letters only" });
    }

    if (!["Male", "Female", "Other"].includes(trimmedGender)) {
      return res.status(400).json({ error: "Please select a valid gender" });
    }

    const genderCodeByLabel = {
      Male: "M",
      Female: "F",
      Other: "O",
    };
    const genderCode = genderCodeByLabel[trimmedGender];

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({ error: "Please enter a valid email address" });
    }

    if (!MOBILE_REGEX.test(trimmedMobile)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
    }

    await client.query("BEGIN");

    const existingApplicant = await findApplicantByMobile(trimmedMobile, client);

    if (existingApplicant) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "An applicant with this mobile number already exists" });
    }

    const applicantTypeResult = await client.query(
      `
        SELECT id
        FROM user_type_master
        WHERE UPPER(type_name) = 'APPLICANT'
        LIMIT 1
      `
    );

    const applicantUserTypeId = applicantTypeResult.rows[0]?.id || null;
    const applicantUserId = await generateApplicantUserId(client);
    const hashedPassword = hashPassword(trimmedMobile);

    const insertResult = await client.query(
      `
INSERT INTO user_master (
  id, user_name, organisation_name, login_id, password, email_id, mobile_no,
  gender, active_flag, created_by, role_id, user_type_id,
  designation, passwordchange_flag, is_logged
)
VALUES (
  $1, $2, $3, $1, $4, $5, $6, $7, 'Y', $1, $8, $9, 'Applicant', 'N', false
)
RETURNING id, user_name, organisation_name, login_id, email_id, mobile_no, role_id,
          user_type_id, designation, created_on
      `,
     [
  applicantUserId,           // $1  → id, login_id, created_by
  trimmedName,               // $2  → user_name
  trimmedOrganisationName,   // $3  → organisation_name  ← NEW
  hashedPassword,            // $4  → password
  trimmedEmail,              // $5  → email_id
  trimmedMobile,             // $6  → mobile_no
  genderCode,                // $7  → gender
  APPLICANT_ROLE_ID,         // $8  → role_id
  applicantUserTypeId,       // $9  → user_type_id
]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Applicant registered successfully",
      data: insertResult.rows[0],
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Applicant registration rollback failed:", rollbackError);
    }
    console.error("Applicant registration error:", error);
    return res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

const logoutOfficer = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    await pool.query(
      `
        UPDATE user_master
        SET is_logged = false
        WHERE id = $1
      `,
      [userId]
    );

    if (req.user && req.user.sessionId) {
      await pool.query(
        `
          UPDATE login_history
          SET is_active = false, logout_time = NOW()
          WHERE session_id = $1
        `,
        [req.user.sessionId]
      );
    } else {
      await pool.query(
        `
          UPDATE login_history
          SET is_active = false, logout_time = NOW()
          WHERE user_id = $1 AND is_active = true
        `,
        [userId]
      );
    }

    return res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    console.error("Officer logout error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};
const checkSessionValid = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const result = await pool.query(
      `SELECT is_logged FROM user_master WHERE id = $1 LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ valid: false });
    }

    return res.status(200).json({
      valid: result.rows[0].is_logged === true,
    });
  } catch (error) {
    console.error("checkSessionValid error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};
module.exports = {
  checkApplicantMobileAvailability,
  createOfficerUser,
  getOfficerDashboardConfig,
  loginOfficer,
  logoutOfficer,
  registerApplicant,
  checkSessionValid,
};
