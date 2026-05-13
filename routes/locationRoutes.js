const express = require("express");
const router = express.Router();
const {
  getBlocks,
  getBlocksByDivision,
  getCircles,
  getDistrictsByCircle,
  getDistricts,
  getDivisionsByCircle,
  getDivisionsByDistrict,
  getPanchayats,
} = require("../controllers/locationController");

router.get("/circles", getCircles);
router.get("/districts-by-circle/:circle_code", getDistrictsByCircle);
router.get("/divisions/:circle_code", getDivisionsByCircle);
router.get("/divisions-by-district/:district_code", getDivisionsByDistrict);
router.get("/division-blocks/:division_code", getBlocksByDivision);
router.get("/districts", getDistricts);
router.get("/blocks/:district_code", getBlocks);
router.get("/panchayats/:block_code", getPanchayats);

module.exports = router;
