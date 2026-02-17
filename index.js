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
    const numMedia = parseInt(req.body.NumMedia || "0");

    console.log("Incoming from:", from, "message:", body);

    if (from) {
      lastCaller = from;
    }

    const incomingMsg = body.trim().toLowerCase();

    /* -----------------------
       SMS Reply Logic
    ----------------------- */
    if (incomingMsg) {

      // YES reply
      if (incomingMsg === "yes" && lastCaller) {
        await client.messages.create({
          from: TWILIO_PHONE_NUMBER,
          to: lastCaller,
          body:
            "Great — plumber will call you shortly. Reply 1 for emergency, 2 for non-urgent, or 3 to request a quote."
        });

        res.type("text/xml");
        return res.send("<Response></Response>");
      }

      // Emergency
      if (incomingMsg === "1") {
        await client.messages.create({
          from: TWILIO_PHONE_NUMBER,
          to: PLUMBER_PHONE_NUMBER,
          body: `🚨 EMERGENCY lead from ${lastCaller}`
        });

        res.type("text/xml");
        return res.send("<Response></Response>");
      }

      // Non-urgent
      if (incomingMsg === "2") {
        await client.messages.create({
          from: TWILIO_PHONE_NUMBER,
          to: PLUMBER_PHONE_NUMBER,
          body: `Non-urgent job lead from ${lastCaller}`
        });

        res.type("text/xml");
        return res.send("<Response></Response>");
      }

      // Quote request
      if (incomingMsg === "3") {
        await client.messages.create({
          from: TWILIO_PHONE_NUMBER,
          to: lastCaller,
          body:
            "Please reply with photos or a description of the issue for a quote."
        });

        res.type("text/xml");
        return res.send("<Response></Response>");
      }
    }

    /* -----------------------
       Photo forwarding
    ----------------------- */
    if (numMedia > 0) {
      let mediaLinks = [];

      for (let i = 0; i < numMedia; i++) {
        mediaLinks.push(req.body[`MediaUrl${i}`]);
      }

      await client.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `Customer sent images for quote.\nNumber: ${from}\nImages:\n${mediaLinks.join("\n")}`
      });

      res.type("text/xml");
      return res.send("<Response></Response>");
    }

    /* -----------------------
       Missed Call Flow
    ----------------------- */
    if (from) {
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
    }

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
