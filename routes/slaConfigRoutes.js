const express = require("express");
const {
  listStageSlaConfigs,
  saveStageSlaConfig,
} = require("../controllers/slaConfigController");

const router = express.Router();

router.get("/stages", listStageSlaConfigs);
router.post("/save", saveStageSlaConfig);

module.exports = router;
