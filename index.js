const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PLUMBER_PHONE_NUMBER
} = process.env;

const client = twilio(
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN
);

// Health check (Railway NEEDS this)
app.get("/", (req, res) => {
  res.send("Plumber server running ✅");
});

// Twilio webhook
app.post("/twilio", async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || "";

    // Auto-reply to customer
    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body: "Sorry we missed your call. Reply YES and we’ll call you back."
    });

    // Notify plumber
      await client.messages.create({
    from: TWILIO_PHONE_NUMBER,
    to: PLUMBER_PHONE_NUMBER,
    body: `Missed call lead 🚨 Number: ${from}`
  });

  res.type("text/xml");
  res.send(`
<Response>
  <Hangup/>
</Response>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
