const crypto = require("crypto");
const pool = require("../db/db");

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_HASH_PREFIX = "";

const hashPassword = (plainPassword) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return `${PASSWORD_HASH_PREFIX}$${salt}$${derivedKey}`;
};

const verifyPassword = (plainPassword, storedPassword) => {
  if (!storedPassword || !plainPassword) {
    return false;
  }

  const stored = String(storedPassword).trim();

  if (stored.startsWith("$")) {
    const [, salt, storedHash] = stored.split("$");
    if (!salt || !storedHash) {
      return false;
    }

    try {
      const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
      return crypto.timingSafeEqual(
        Buffer.from(storedHash, "hex"),
        Buffer.from(derivedKey, "hex")
      );
    } catch {
      return false;
    }
  }

  if (/^[0-9a-f]{128}$/i.test(stored)) {
    const sha512Hash = crypto.createHash("sha512").update(plainPassword).digest("hex");

    try {
      return crypto.timingSafeEqual(
        Buffer.from(stored.toLowerCase(), "hex"),
        Buffer.from(sha512Hash, "hex")
      );
    } catch {
      return false;
    }
  }

  return stored === plainPassword;
};

const validateNewPassword = (newPassword) => {
  if (!newPassword || newPassword.length < PASSWORD_MIN_LENGTH) {
    return `New password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  }

  if (!/[A-Z]/.test(newPassword)) {
    return "New password must contain at least one uppercase letter";
  }

  if (!/[a-z]/.test(newPassword)) {
    return "New password must contain at least one lowercase letter";
  }

  if (!/\d/.test(newPassword)) {
    return "New password must contain at least one number";
  }

  if (!/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]~`';]/.test(newPassword)) {
    return "New password must contain at least one special character";
  }

  return "";
};

const changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const username = String(req.body?.username || "").trim();
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!userId && !username) {
      return res.status(400).json({ error: "Username or active session is required" });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: "Current password, new password, and confirm password are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "New password and confirm password do not match" });
    }

    const passwordError = validateNewPassword(newPassword);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    let result;
    if (userId) {
      result = await pool.query(
        `
          SELECT
            um.id,
            um.password,
            um.login_id,
            um.user_name,
            um.email_id,
            um.mobile_no,
            um.role_id,
            um.user_type_id,
            COALESCE(utm.type_name, dr.role_name) AS role_name
          FROM user_master um
          LEFT JOIN user_type_master utm ON utm.id = um.user_type_id
          LEFT JOIN dbrap_role dr ON dr.role_id::text = um.role_id
          WHERE um.id = $1
            AND COALESCE(um.active_flag, 'Y') = 'Y'
          LIMIT 1
        `,
        [userId]
      );
    } else {
      result = await pool.query(
        `
          SELECT
            um.id,
            um.password,
            um.login_id,
            um.user_name,
            um.email_id,
            um.mobile_no,
            um.role_id,
            um.user_type_id,
            COALESCE(utm.type_name, dr.role_name) AS role_name
          FROM user_master um
          LEFT JOIN user_type_master utm ON utm.id = um.user_type_id
          LEFT JOIN dbrap_role dr ON dr.role_id::text = um.role_id
          WHERE um.login_id = $1
            AND COALESCE(um.active_flag, 'Y') = 'Y'
          LIMIT 1
        `,
        [username]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User account not found or inactive" });
    }

    const user = result.rows[0];

    if (!verifyPassword(currentPassword, user.password)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    if (verifyPassword(newPassword, user.password)) {
      return res.status(400).json({ error: "New password must be different from the current password" });
    }

    if (userId) {
      // Normal logged-in password change
      await pool.query(
        `
          UPDATE user_master
          SET password = $1,
              passwordchange_flag = 'Y',
              is_logged = true
          WHERE id = $2
        `,
        [hashPassword(newPassword), userId]
      );

      const sessionId = crypto.randomUUID();
      const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
      const userAgent = req.headers["user-agent"] || null;

      const { saveLoginHistory } = require("./historyController");
      const jwt = require("jsonwebtoken");

      await saveLoginHistory(
        user.id,
        user.login_id,
        user.user_name,
        ipAddress,
        userAgent,
        "true",
        sessionId,
        true
      );

      const token = jwt.sign(
        {
          id: user.id,
          loginId: user.login_id,
          roleId: user.role_id,
          roleName: String(user.role_id) === "7" ? "Applicant" : user.role_name,
          sessionId,
        },
        process.env.JWT_SECRET,
        { expiresIn: "24h" }
      );

      return res.status(200).json({
        message: "Password changed successfully",
        passwordChangeRequired: false,
        token,
        user: {
          id: user.id,
          name: user.user_name,
          loginId: user.login_id,
          email: user.email_id,
          mobileNo: user.mobile_no,
          roleId: user.role_id,
          userTypeId: user.user_type_id,
          roleName: String(user.role_id) === "7" ? "Applicant" : user.role_name,
          passwordChangeRequired: false,
        }
      });
    } else {
      // Forced password change from login page (public access without token)
      await pool.query(
        `
          UPDATE user_master
          SET password = $1,
              passwordchange_flag = 'Y'
          WHERE id = $2
        `,
        [hashPassword(newPassword), user.id]
      );

      return res.status(200).json({
        message: "Password changed successfully",
        passwordChangeRequired: false,
      });
    }
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  changePassword,
};
