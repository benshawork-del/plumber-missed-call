const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

let lastCaller = null;

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
    const body = req.body.Body || "";

    console.log("Incoming from:", from);

    // Save last caller for YES replies
    if (from) {
      lastCaller = from;
    }

    const incomingMsg = body.trim().toLowerCase();

    // ----- YES auto reply -----
    if (incomingMsg === "yes" && lastCaller) {
      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: lastCaller,
        body: "Plumber is calling you back shortly."
      });

      res.type("text/xml");
      return res.send("<Response></Response>");
    }

    // ----- Normal missed call flow -----
    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body:
        "Hi — sorry we missed your call. Reply YES and we'll call you straight back."
    });

    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: PLUMBER_PHONE_NUMBER,
      body: `Missed call lead 🚨 Number: ${from}`
    });

    // Hang up instantly
    res.type("text/xml");
    res.send(`
<Response>
  <Hangup/>
</Response>
`);

  } catch (err) {
    console.error("Webhook error:", err);
    res.type("text/xml");
    res.send("<Response></Response>");
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
