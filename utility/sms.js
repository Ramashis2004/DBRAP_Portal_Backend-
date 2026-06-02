const axios = require("axios");
const FormData = require("form-data");

const sendOTPSMS = async (mobile, otp) => {
  const data = new FormData();
  data.append("template_id", "1007529288081313959");
  data.append("phonenumber", mobile);
  data.append("department_id", "D047009");
  data.append("action", "sendOTPSMS");
  data.append("source", "ODIGOV");
  data.append(
    "sms_content",
    `Your OTP for Gramsewa Nidhi Portal is ${otp}. Please do not share this with anyone. Panchayati Raj & Drinking Water Dept. - Govt. of Odisha`
  );
  await axios.post("https://govtsms.odisha.gov.in/api/api.php", data, {
    headers: data.getHeaders(),
  });
  console.log("Your Temporary Otp is :", otp);

};

module.exports = { sendOTPSMS };