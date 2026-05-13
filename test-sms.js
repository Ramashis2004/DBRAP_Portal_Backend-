const params = new URLSearchParams({
  template_id: "1007529288081313959",
  phonenumber: "7437979471", // use a real number
  department_id: "D047009",
  action: "sendOTPSMS",
  source: "ODIGOV",
});

fetch(`https://govtsms.odisha.gov.in/api/api.php?${params.toString()}`)
  .then(async (res) => {
    const text = await res.text();
    console.log("Status:", res.status);
    console.log("Body:", JSON.stringify(text));
  })
  .catch((err) => console.error("Error:", err));