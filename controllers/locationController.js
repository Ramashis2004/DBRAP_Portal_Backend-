const pool = require("../db/db");

const getCircles = async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT circle_code, circle_name
        FROM dbrap_circle
        WHERE COALESCE(active_status, true) = true
        ORDER BY circle_name ASC
      `
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching circles:", error);
    res.status(500).json({ error: "Failed to fetch circles" });
  }
};

const getDistrictsByCircle = async (req, res) => {
  const { circle_code } = req.params;

  try {
    const result = await pool.query(
      `
        SELECT district_code, district_name, circle_code
        FROM dbrap_lgd_district
        WHERE circle_code = $1
        ORDER BY district_name ASC
      `,
      [circle_code]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching districts by circle:", error);
    res.status(500).json({ error: "Failed to fetch districts" });
  }
};

const getDivisionsByCircle = async (req, res) => {
  const { circle_code } = req.params;

  try {
    const result = await pool.query(
      `
        SELECT DISTINCT d.division_code, d.division_name, d.dist_id AS district_code
        FROM dbrap_division d
        INNER JOIN dbrap_lgd_district district
          ON district.district_code = d.dist_id
        WHERE district.circle_code = $1
          AND COALESCE(d.active_status, true) = true
        ORDER BY d.division_name ASC
      `,
      [circle_code]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching divisions:", error);
    res.status(500).json({ error: "Failed to fetch divisions" });
  }
};

const getDivisionsByDistrict = async (req, res) => {
  const { district_code } = req.params;

  try {
    const result = await pool.query(
      `
        SELECT division_code, division_name, dist_id AS district_code
        FROM dbrap_division
        WHERE dist_id = $1
          AND COALESCE(active_status, true) = true
        ORDER BY division_name ASC
      `,
      [district_code]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching divisions by district:", error);
    res.status(500).json({ error: "Failed to fetch divisions" });
  }
};

const getBlocksByDivision = async (req, res) => {
  const { division_code } = req.params;

  try {
    const result = await pool.query(
      `
        SELECT block_code, block_name, district_code, division_code
        FROM dbrap_lgd_block
        WHERE division_code = $1
          AND COALESCE(active_status, true) = true
        ORDER BY block_name ASC
      `,
      [division_code]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching blocks by division:", error);
    res.status(500).json({ error: "Failed to fetch blocks" });
  }
};

// Get all districts
const getDistricts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT district_code, district_name FROM dbrap_lgd_district ORDER BY district_name ASC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching districts:", error);
    res.status(500).json({ error: "Failed to fetch districts" });
  }
};

// Get blocks by district code
const getBlocks = async (req, res) => {
  const { district_code } = req.params;
  try {
    const result = await pool.query(
      "SELECT block_code, block_name FROM dbrap_lgd_block WHERE district_code = $1 ORDER BY block_name ASC",
      [district_code]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching blocks:", error);
    res.status(500).json({ error: "Failed to fetch blocks" });
  }
};

// Get panchayats by block code
const getPanchayats = async (req, res) => {
  const { block_code } = req.params;
  try {
    const result = await pool.query(
      "SELECT panchayat_code, panchayat_name FROM dbrap_lgd_panchayat WHERE block_code = $1 ORDER BY panchayat_name ASC",
      [block_code]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching panchayats:", error);
    res.status(500).json({ error: "Failed to fetch panchayats" });
  }
};

module.exports = {
  getBlocksByDivision,
  getDistrictsByCircle,
  getDistricts,
  getCircles,
  getDivisionsByCircle,
  getDivisionsByDistrict,
  getBlocks,
  getPanchayats
};
