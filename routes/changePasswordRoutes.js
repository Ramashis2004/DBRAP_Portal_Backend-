const express = require("express");
const { changePassword } = require("../controllers/changePasswordController");

const router = express.Router();

router.post("/change", changePassword);

module.exports = router;
