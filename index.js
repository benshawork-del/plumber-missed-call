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

// Health check
app.get("/", (req, res) => {
  res.send("Server is running");
});

// Twilio webhook
app.post("/twilio", async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || "Missed call";

    console.log("Incoming from:", from);

    // SMS to customer
    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body:
        "Hi — sorry we missed your call. Reply YES and we'll call you straight back."
    });

    // SMS to plumber
    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: PLUMBER_PHONE_NUMBER,
      body: `Missed call lead 🚨 Number: ${from}`
    });

    // Hang up call instantly
    res.type("text/xml");
    res.send(`
<Response>
  <Hangup/>
</Response>
`);

  } catch (err) {
    console.error("Webhook error:", err);
    res.send("<Response></Response>");
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
