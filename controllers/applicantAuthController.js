const crypto = require("crypto");

const pool = require("../db/db");
const { saveLoginHistory } = require("./historyController"); // ← add this

const APPLICANT_ROLE_ID = "7";
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const PASSWORD_HASH_PREFIX = "";

// ── Password verification (same logic as userController) ─────────────────────
const verifyPassword = (plainPassword, storedPassword) => {
  if (!storedPassword) return false;

  // Legacy plain-text fallback
  if (!storedPassword.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
    return storedPassword === plainPassword;
  }

  const [, salt, storedHash] = storedPassword.split("$");
  if (!salt || !storedHash) return false;

  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(storedHash,  "hex"),
    Buffer.from(derivedKey, "hex")
  );
};

const normalizeMobileNumber = (mobileNo) => String(mobileNo || "").trim().replace(/\D/g, "");

const findApplicantByMobile = async (mobileNo) => {
  const trimmedMobile = normalizeMobileNumber(mobileNo);

  if (!MOBILE_REGEX.test(trimmedMobile)) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id, user_name, organisation_name, login_id, email_id, mobile_no, role_id, user_type_id
      FROM user_master
      WHERE mobile_no = $1
        AND role_id = $2
        AND COALESCE(active_flag, 'Y') = 'Y'
      LIMIT 1
    `,
    [trimmedMobile, APPLICANT_ROLE_ID]
  );

  return result.rows[0] || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// checkApplicantMobile — unchanged, no login event here
// ─────────────────────────────────────────────────────────────────────────────
const checkApplicantMobile = async (req, res) => {
  try {
    const trimmedMobile = normalizeMobileNumber(req.query.mobile_number || req.body?.mobile_number);

    if (!MOBILE_REGEX.test(trimmedMobile)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
    }

    const applicant = await findApplicantByMobile(trimmedMobile);

    if (!applicant) {
      return res.status(404).json({
        error: "Applicant not found for this mobile Number Please Register the Applicant",
      });
    }

    return res.status(200).json({
      exists: true,
      applicant: {
        id: applicant.id,
        name: applicant.user_name,
        organisation_name: applicant.organisation_name || "",  // ← ADD
        loginId: applicant.login_id,
        email: applicant.email_id,
        mobileNo: applicant.mobile_no,
        roleId: applicant.role_id,
        userTypeId: applicant.user_type_id,
      },
    });
  } catch (error) {
    console.error("Applicant mobile check error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// loginApplicant — saveLoginHistory added at every branch
// ─────────────────────────────────────────────────────────────────────────────
const loginApplicant = async (req, res) => {
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  try {
    const trimmedMobile = normalizeMobileNumber(req.body?.mobile_number);

    // ── FAILED: invalid mobile format ─────────────────────────────────────────
    if (!MOBILE_REGEX.test(trimmedMobile)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
      // Note: no history saved here — not even a valid login attempt
    }

    const applicant = await findApplicantByMobile(trimmedMobile);

    // ── FAILED: applicant not registered ─────────────────────────────────────
    if (!applicant) {
      await saveLoginHistory(
        null,            // userId   → unknown
        trimmedMobile,   // loginId  → mobile used as login credential
        null,            // userName → unknown
        ipAddress,
        userAgent,
        "FAILURE"
      );
      return res.status(404).json({
        error: "Applicant not found for this mobile Number Please Register the Applicant",
      });
    }

    // ── SUCCESS ───────────────────────────────────────────────────────────────
    await pool.query(
      `UPDATE user_master SET is_logged = true WHERE id = $1`,
      [applicant.id]
    );

    await saveLoginHistory(
      applicant.id,
      applicant.login_id,  // login_id = applicant's USER00001 style ID
      applicant.user_name,
      ipAddress,
      userAgent,
      "SUCCESS"
    );

    return res.status(200).json({
      message: "Applicant login successful",
      applicant: {
        id: applicant.id,
        name: applicant.user_name,
        organisation_name: applicant.organisation_name || "",  // ← ADD
        loginId: applicant.login_id,
        email: applicant.email_id,
        mobileNo: applicant.mobile_no,
        roleId: applicant.role_id,
        userTypeId: applicant.user_type_id,
      },
    });
  } catch (error) {
    console.error("Applicant login error:", error);

    // ── FAILED: server error ──────────────────────────────────────────────────
    await saveLoginHistory(
      null,
      normalizeMobileNumber(req.body?.mobile_number) || null,
      null,
      ipAddress,
      userAgent,
      "FAILURE"
    );

    return res.status(500).json({ error: "Server Error" });
  }
};

const loginApplicantWithPassword = async (req, res) => {
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  try {
    const loginId  = String(req.body?.login_id  || "").trim();
    const password = String(req.body?.password  || "");

    if (!loginId || !password) {
      return res.status(400).json({ error: "User ID and password are required" });
    }

    // ── Look up applicant by login_id ──────────────────────────────────────
    const result = await pool.query(
      `
        SELECT
          id,
          user_name,
          organisation_name,
          login_id,
          password,
          email_id,
          mobile_no,
          role_id,
          user_type_id,
          active_flag
        FROM user_master
        WHERE login_id = $1
          AND role_id   = $2
        LIMIT 1
      `,
      [loginId, APPLICANT_ROLE_ID]
    );

    // ── User not found ─────────────────────────────────────────────────────
    if (result.rows.length === 0) {
      await saveLoginHistory(null, loginId, null, ipAddress, userAgent, "FAILURE");
      return res.status(401).json({ error: "Invalid User ID or password" });
    }

    const applicant = result.rows[0];

    // ── Account inactive ───────────────────────────────────────────────────
    if (applicant.active_flag !== "Y") {
      await saveLoginHistory(applicant.id, applicant.login_id, applicant.user_name, ipAddress, userAgent, "FAILURE");
      return res.status(403).json({ error: "This account is inactive. Please contact support." });
    }

    // ── Wrong password ─────────────────────────────────────────────────────
    if (!verifyPassword(password, applicant.password)) {
      await saveLoginHistory(applicant.id, applicant.login_id, applicant.user_name, ipAddress, userAgent, "FAILURE");
      return res.status(401).json({ error: "Invalid User ID or password" });
    }

    // ── Success ────────────────────────────────────────────────────────────
    await pool.query(
      `UPDATE user_master SET is_logged = true WHERE id = $1`,
      [applicant.id]
    );

    await saveLoginHistory(
      applicant.id,
      applicant.login_id,
      applicant.user_name,
      ipAddress,
      userAgent,
      "SUCCESS"
    );

    return res.status(200).json({
      message: "Login successful",
      applicant: {
        id:                applicant.id,
        name:              applicant.user_name,
        organisation_name: applicant.organisation_name || "",
        loginId:           applicant.login_id,
        email:             applicant.email_id,
        mobileNo:          applicant.mobile_no,
        roleId:            applicant.role_id,
        userTypeId:        applicant.user_type_id,
      },
    });
  } catch (error) {
    console.error("loginApplicantWithPassword error:", error);
    await saveLoginHistory(
      null,
      String(req.body?.login_id || "").trim() || null,
      null,
      ipAddress,
      userAgent,
      "FAILURE"
    );
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  checkApplicantMobile,
  loginApplicant,
  loginApplicantWithPassword,
};
