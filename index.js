const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

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

// Simple in-memory state tracking (per phone number)
const userState = {};

// Health check
app.get("/", (req, res) => {
  res.send("Server is running");
});

// Twilio webhook
app.post("/twilio", async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || "";
    const numMedia = parseInt(req.body.NumMedia || "0");
    const incomingMsg = body.trim().toLowerCase();

    console.log("Incoming from:", from, "message:", body);

    if (!from) {
      return res.send("<Response></Response>");
    }

    /* =========================
       IMAGE HANDLING
    ========================== */
    if (numMedia > 0) {
      let mediaLinks = [];

      for (let i = 0; i < numMedia; i++) {
        mediaLinks.push(req.body[`MediaUrl${i}`]);
      }

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `📸 Customer sent images\n` +
          `Number: ${from}\n` +
          `Images:\n${mediaLinks.join("\n")}`
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       YES REPLY
    ========================== */
    if (incomingMsg === "yes") {
      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body:
          "Great — plumber will call you shortly.\n\nReply:\n1 for Emergency\n2 for Non-Urgent\n3 for Quote"
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       OPTION 1 - EMERGENCY
    ========================== */
    if (incomingMsg === "1") {
      userState[from] = "awaiting_emergency_description";

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Please briefly describe your emergency issue."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       OPTION 2 - NON URGENT
    ========================== */
    if (incomingMsg === "2") {
      userState[from] = "awaiting_nonurgent_description";

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Please briefly describe the issue."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       OPTION 3 - QUOTE
    ========================== */
    if (incomingMsg === "3") {
      userState[from] = "awaiting_quote";

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: from,
        body: "Please reply with photos or a description of the issue for a quote."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       DESCRIPTION HANDLING
    ========================== */
    if (userState[from] === "awaiting_emergency_description") {

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `🚨 EMERGENCY LEAD\n` +
          `Customer: ${from}\n` +
          `Issue: ${body}`
      });

      delete userState[from];

      return res.send("<Response></Response>");
    }

    if (userState[from] === "awaiting_nonurgent_description") {

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `🔧 NON-URGENT LEAD\n` +
          `Customer: ${from}\n` +
          `Issue: ${body}`
      });

      delete userState[from];

      return res.send("<Response></Response>");
    }

    if (userState[from] === "awaiting_quote") {

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `💬 QUOTE REQUEST\n` +
          `Customer: ${from}\n` +
          `Details: ${body}`
      });

      delete userState[from];

      return res.send("<Response></Response>");
    }

    /* =========================
       MISSED CALL FLOW
    ========================== */
    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: from,
      body:
        "Hi — sorry we missed your call.\nReply YES and we'll respond immediately."
    });

    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: PLUMBER_PHONE_NUMBER,
      body: `📞 Missed call lead\nNumber: ${from}`
    });

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
