const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const pool = require("../db/db");
const { saveLoginHistory } = require("./historyController");
const { sendOTPSMS } = require("../utility/sms");

const APPLICANT_ROLE_ID = "7";
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const PASSWORD_HASH_PREFIX = "";

// ── In-memory OTP store for applicant mobile-OTP login ────────────────────────
// Fortify: Privacy Violation / auth-bypass remediation. The OTP is
// generated here, on the server, and is never sent back to the client in
// any response payload — only its delivery status is. Structure:
//   mobileNo → { otp, expiresAt, verifyAttempts, sendCount, resendAvailableAt, resendBlockedUntil }
const applicantOtpStore = new Map();

const OTP_TTL_MS              = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_DIGITS          = 6;
const OTP_RESEND_COOLDOWN_MS  = 25 * 1000;
const OTP_MAX_SEND_ATTEMPTS   = 3;
const OTP_RESEND_LOCKOUT_MS   = 30 * 60 * 1000;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

const generateOtp = () =>
  String(Math.floor(Math.random() * 10 ** OTP_MAX_DIGITS)).padStart(OTP_MAX_DIGITS, "0");

const timingSafeEqualStrings = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

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
      SELECT id, user_name, organisation_name, login_id, email_id, mobile_no, role_id, user_type_id,
             COALESCE(passwordchange_flag, 'N') AS passwordchange_flag,
             COALESCE(is_logged, false) AS is_logged
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
        organisation_name: applicant.organisation_name || "",
        loginId: applicant.login_id,
        email: applicant.email_id,
        mobileNo: applicant.mobile_no,
        roleId: applicant.role_id,
        userTypeId: applicant.user_type_id,
        passwordChangeRequired: applicant.passwordchange_flag !== "Y",
      },
    });
  } catch (error) {
    console.error("Applicant mobile check error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// sendApplicantOtp — generates and stores the OTP server-side, sends via
// sendOTPSMS() (utility/sms.js), and never returns the OTP value itself
// in the response. This replaces the previous route handler that took
// `otp` straight from the client and merely relayed it.
// ─────────────────────────────────────────────────────────────────────────────
const sendApplicantOtp = async (req, res) => {
  try {
    const trimmedMobile = normalizeMobileNumber(req.body?.mobile);

    if (!MOBILE_REGEX.test(trimmedMobile)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
    }

    const applicant = await findApplicantByMobile(trimmedMobile);
    if (!applicant) {
      return res.status(404).json({
        error: "Applicant not found for this mobile Number Please Register the Applicant",
      });
    }

    const existingEntry = applicantOtpStore.get(trimmedMobile);
    const now = Date.now();

    if (existingEntry?.resendBlockedUntil && now < existingEntry.resendBlockedUntil) {
      const retryAfterSeconds = Math.ceil((existingEntry.resendBlockedUntil - now) / 1000);
      return res.status(429).json({
        error: "You have exceeded your OTP request limit. Please try again after 30 minutes.",
        resendBlocked: true,
        retryAfterSeconds,
      });
    }

    if (existingEntry?.resendAvailableAt && now < existingEntry.resendAvailableAt) {
      const retryAfterSeconds = Math.ceil((existingEntry.resendAvailableAt - now) / 1000);
      return res.status(429).json({
        error: `Please wait ${retryAfterSeconds} seconds before resending OTP.`,
        resendBlocked: false,
        retryAfterSeconds,
      });
    }

    const sendCount = (existingEntry?.sendCount || 0) + 1;
    const isLockedOutAfterThisSend = sendCount >= OTP_MAX_SEND_ATTEMPTS;
    const resendAvailableAt = isLockedOutAfterThisSend ? now + OTP_RESEND_LOCKOUT_MS : now + OTP_RESEND_COOLDOWN_MS;

    const otp = generateOtp();
    // Never log or return the OTP value itself.

    applicantOtpStore.set(trimmedMobile, {
      otp,
      expiresAt: now + OTP_TTL_MS,
      verifyAttempts: 0,
      sendCount,
      resendAvailableAt,
      resendBlockedUntil: isLockedOutAfterThisSend ? now + OTP_RESEND_LOCKOUT_MS : 0,
    });

    setTimeout(() => {
      const entry = applicantOtpStore.get(trimmedMobile);
      if (entry && entry.otp === otp) applicantOtpStore.delete(trimmedMobile);
    }, OTP_TTL_MS);

    let smsSent = true;
    try {
      await sendOTPSMS(trimmedMobile, otp);
    } catch (smsErr) {
      smsSent = false;
      console.error("Applicant login OTP SMS error:", smsErr.message);
    }

    return res.status(200).json({
      message: smsSent
        ? "OTP sent to your registered mobile number."
        : "OTP generated but SMS delivery failed. Please try again shortly.",
      smsSent,
      resendAfterSeconds: Math.ceil((isLockedOutAfterThisSend ? OTP_RESEND_LOCKOUT_MS : OTP_RESEND_COOLDOWN_MS) / 1000),
      resendBlocked: isLockedOutAfterThisSend,
    });
  } catch (error) {
    console.error("sendApplicantOtp error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// loginApplicant — now requires and verifies the OTP server-side before
// issuing a session. Mobile number alone is no longer sufficient; the OTP
// must match what sendApplicantOtp generated and stored, and is
// invalidated after OTP_MAX_VERIFY_ATTEMPTS incorrect guesses or after
// OTP_TTL_MS.
// ─────────────────────────────────────────────────────────────────────────────
const loginApplicant = async (req, res) => {
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;

  try {
    const trimmedMobile = normalizeMobileNumber(req.body?.mobile_number);
    const submittedOtp  = String(req.body?.otp || "").trim();
    const forceLogin    = Boolean(req.body?.forceLogin);

    // ── FAILED: invalid mobile format ─────────────────────────────────────────
    if (!MOBILE_REGEX.test(trimmedMobile)) {
      return res.status(400).json({ error: "Mobile number must be a valid 10-digit Indian mobile number" });
      // Note: no history saved here — not even a valid login attempt
    }

    if (!submittedOtp) {
      return res.status(400).json({ error: "OTP is required" });
    }

    // ── Verify OTP server-side ────────────────────────────────────────────────
    const otpEntry = applicantOtpStore.get(trimmedMobile);

    if (!otpEntry) {
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    if (Date.now() > otpEntry.expiresAt) {
      applicantOtpStore.delete(trimmedMobile);
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (!timingSafeEqualStrings(otpEntry.otp, submittedOtp)) {
      otpEntry.verifyAttempts = (otpEntry.verifyAttempts || 0) + 1;

      if (otpEntry.verifyAttempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        applicantOtpStore.delete(trimmedMobile);
        return res.status(400).json({ error: "Too many incorrect attempts. Please request a new OTP." });
      }

      applicantOtpStore.set(trimmedMobile, otpEntry);
      return res.status(400).json({ error: "Incorrect OTP. Please try again." });
    }

    // OTP verified — consume it immediately so it can't be replayed.
    applicantOtpStore.delete(trimmedMobile);

    const applicant = await findApplicantByMobile(trimmedMobile);

    // ── FAILED: applicant not registered ─────────────────────────────────────
    if (!applicant) {
      await saveLoginHistory(
        null,            // userId
        trimmedMobile,   // loginId
        null,            // userName
        ipAddress,
        userAgent,
        "false",
        null,
        false
      );
      return res.status(404).json({
        error: "Applicant not found for this mobile Number Please Register the Applicant",
      });
    }

    if (applicant.is_logged && !forceLogin) {
      return res.status(409).json({
        code: "ALREADY_LOGGED_IN",
        error: "This login ID is already logged in. Do you want to logout there and login here?",
      });
    }
    if (applicant.is_logged && forceLogin) {
      await pool.query(
        `UPDATE user_master SET is_logged = false WHERE id = $1`,
        [applicant.id]
      );
    }

    // ── SUCCESS ───────────────────────────────────────────────────────────────
    await pool.query(
      `UPDATE user_master SET is_logged = true WHERE id = $1`,
      [applicant.id]
    );

    const sessionId = crypto.randomUUID();
    if (forceLogin) {
      await pool.query(
        `UPDATE login_history SET is_active = false, logout_time = NOW() WHERE user_id = $1 AND is_active = true`,
        [applicant.id]
      );
    }
    await saveLoginHistory(
      applicant.id,
      applicant.login_id,
      applicant.user_name,
      ipAddress,
      userAgent,
      "true",
      sessionId,
      true
    );

    const token = jwt.sign(
      { id: applicant.id, loginId: applicant.login_id, roleId: applicant.role_id, roleName: "Applicant", sessionId: sessionId },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.status(200).json({
      message: "Applicant login successful",
      token,
      applicant: {
        id: applicant.id,
        name: applicant.user_name,
        organisation_name: applicant.organisation_name || "",
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
      "false",
      null,
      false
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
    const forceLogin = Boolean(req.body?.forceLogin);

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
          active_flag,
          COALESCE(passwordchange_flag, 'N') AS passwordchange_flag,
          COALESCE(is_logged, false) AS is_logged
        FROM user_master
        WHERE login_id = $1
          AND role_id   = $2
        ORDER BY CASE WHEN active_flag = 'Y' THEN 0 ELSE 1 END, id DESC
        LIMIT 1
      `,
      [loginId, APPLICANT_ROLE_ID]
    );

    // ── User not found ─────────────────────────────────────────────────────
    if (result.rows.length === 0) {
      await saveLoginHistory(null, loginId, null, ipAddress, userAgent, "false", null, false);
      return res.status(401).json({ error: "Invalid User ID or password" });
    }

    const applicant = result.rows[0];

    // ── Account inactive ───────────────────────────────────────────────────
    if (applicant.active_flag !== "Y") {
      await saveLoginHistory(applicant.id, applicant.login_id, applicant.user_name, ipAddress, userAgent, "false", null, false);
      return res.status(403).json({ error: "This account is inactive. Please contact support." });
    }

    // ── Wrong password ─────────────────────────────────────────────────────
    if (!verifyPassword(password, applicant.password)) {
      await saveLoginHistory(applicant.id, applicant.login_id, applicant.user_name, ipAddress, userAgent, "false", null, false);
      return res.status(401).json({ error: "Invalid User ID or password" });
    }

    const passwordChangeRequired = applicant.passwordchange_flag !== "Y";

    if (passwordChangeRequired) {
      return res.status(200).json({
        passwordChangeRequired: true,
        username: applicant.login_id,
        role: "applicant",
        message: "Password change required before login",
      });
    }

    if (applicant.is_logged && !forceLogin) {
      return res.status(409).json({
        code: "ALREADY_LOGGED_IN",
        error: "This login ID is already logged in. Do you want to logout there and login here?",
      });
    }
    if (applicant.is_logged && forceLogin) {
      await pool.query(
        `UPDATE user_master SET is_logged = false WHERE id = $1`,
        [applicant.id]
      );
    }

    // ── Success ────────────────────────────────────────────────────────────
    await pool.query(
      `UPDATE user_master SET is_logged = true WHERE id = $1`,
      [applicant.id]
    );

    const sessionId = crypto.randomUUID();
    if (forceLogin) {
      await pool.query(
        `UPDATE login_history SET is_active = false, logout_time = NOW() WHERE user_id = $1 AND is_active = true`,
        [applicant.id]
      );
    }
    await saveLoginHistory(
      applicant.id,
      applicant.login_id,
      applicant.user_name,
      ipAddress,
      userAgent,
      "true",
      sessionId,
      true
    );

    const token = jwt.sign(
      { id: applicant.id, loginId: applicant.login_id, roleId: applicant.role_id, roleName: "Applicant", sessionId: sessionId },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      applicant: {
        id:                applicant.id,
        name:              applicant.user_name,
        organisation_name: applicant.organisation_name || "",
        loginId:           applicant.login_id,
        email:             applicant.email_id,
        mobileNo:          applicant.mobile_no,
        roleId:            applicant.role_id,
        userTypeId:        applicant.user_type_id,
        passwordChangeRequired: applicant.passwordchange_flag !== "Y",
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
      "false",
      null,
      false
    );
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  checkApplicantMobile,
  sendApplicantOtp,
  loginApplicant,
  loginApplicantWithPassword,
};
