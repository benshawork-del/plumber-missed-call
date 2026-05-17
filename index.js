const express = require("express");
const twilio = require("twilio");
const redis = require("redis");

const app = express();

app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PLUMBER_PHONE_NUMBER,
  TWILIO_US_NUMBER,
  TWILIO_UK_NUMBER,
  REDIS_URL
} = process.env;

/* =========================
   TWILIO CLIENT
========================= */

const client = twilio(
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN
);

/* =========================
   REDIS CLIENT
========================= */

const redisClient = redis.createClient({
  url: REDIS_URL
});

redisClient.on("error", (err) => {
  console.error("Redis error:", err);
});

(async () => {
  await redisClient.connect();
  console.log("Connected to Redis");
})();

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Server is running");
});

/* =========================
   TWILIO WEBHOOK
========================= */

app.post("/twilio", async (req, res) => {

  try {

    const from = req.body.From;
    const to = req.body.To;
    const body = req.body.Body || "";
    const numMedia = parseInt(req.body.NumMedia || "0");

    const incomingMsg = body.trim().toLowerCase();

    // GET USER STATE FROM REDIS
    const state = await redisClient.get(from);

    // NUMBER CHECK
    const isUSNumber = to.trim() === TWILIO_US_NUMBER;

    /* =========================
       LOGGING
    ========================== */

    console.log("Incoming from:", from);
    console.log("Twilio number used:", to);
    console.log("Message body:", body);
    console.log("Media count:", numMedia);
    console.log("User state:", state);

    if (!from) {
      return res.send("<Response></Response>");
    }

    /* =========================
       STOP / CANCEL
    ========================== */

    if (
      incomingMsg === "stop" ||
      incomingMsg === "cancel" ||
      incomingMsg === "exit"
    ) {

      await redisClient.del(from);

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Conversation ended.\nReply YES anytime to start again."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       IMAGE HANDLING (US ONLY)
    ========================== */

    if (numMedia > 0 && isUSNumber) {

      let mediaLinks = [];

      for (let i = 0; i < numMedia; i++) {
        mediaLinks.push(req.body[`MediaUrl${i}`]);
      }

      await client.messages.create({
        from: to,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `📸 Customer sent images\n` +
          `Number: ${from}\n\n` +
          `Images:\n${mediaLinks.join("\n")}`
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       YES REPLY
    ========================== */

    if (incomingMsg === "yes") {

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Great — plumber will call you shortly.\n\n" +
          "Reply with a number:\n" +
          "1️⃣ Emergency\n" +
          "2️⃣ Non-Urgent\n" +
          "3️⃣ Quote"
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       OPTION 1 - EMERGENCY
    ========================== */

    if (incomingMsg === "1") {

      await redisClient.set(
        from,
        "awaiting_emergency_description"
      );

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Please briefly describe your emergency issue."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       OPTION 2 - NON URGENT
    ========================== */

    if (incomingMsg === "2") {

      await redisClient.set(
        from,
        "awaiting_nonurgent_description"
      );

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Please briefly describe the issue."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       OPTION 3 - QUOTE
    ========================== */

    if (incomingMsg === "3") {

      await redisClient.set(
        from,
        "awaiting_quote"
      );

      await client.messages.create({
        from: to,
        to: from,
        body: isUSNumber
          ? "Please reply with photos or a description of the issue for a quote."
          : "Please reply with a description of the issue for a quote."
      });

      return res.send("<Response></Response>");
    }

    /* =========================
       EMERGENCY DESCRIPTION
    ========================== */

    if (state === "awaiting_emergency_description") {

      await client.messages.create({
        from: to,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `🚨 EMERGENCY LEAD\n` +
          `Customer: ${from}\n` +
          `Issue: ${body}`
      });

      await redisClient.del(from);

      return res.send("<Response></Response>");
    }

    /* =========================
       NON URGENT DESCRIPTION
    ========================== */

    if (state === "awaiting_nonurgent_description") {

      await client.messages.create({
        from: to,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `🔧 NON-URGENT LEAD\n` +
          `Customer: ${from}\n` +
          `Issue: ${body}`
      });

      await redisClient.del(from);

      return res.send("<Response></Response>");
    }

    /* =========================
       QUOTE DESCRIPTION
    ========================== */

    if (state === "awaiting_quote") {

      await client.messages.create({
        from: to,
        to: PLUMBER_PHONE_NUMBER,
        body:
          `💬 QUOTE REQUEST\n` +
          `Customer: ${from}\n` +
          `Details: ${body}`
      });

      await redisClient.del(from);

      return res.send("<Response></Response>");
    }

    /* =========================
       MISSED CALL FLOW
    ========================== */

    await client.messages.create({
      from: to,
      to: from,
      body:
        "Hi — sorry we missed your call.\n\n" +
        "Reply YES and we'll respond immediately."
    });

    await client.messages.create({
      from: to,
      to: PLUMBER_PHONE_NUMBER,
      body:
        `📞 Missed call lead\n` +
        `Number: ${from}`
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

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
