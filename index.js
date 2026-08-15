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

const requiredEnvironmentVariables = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "PLUMBER_PHONE_NUMBER",
  "TWILIO_US_NUMBER",
  "REDIS_URL"
];

const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  (name) => !process.env[name] || !process.env[name].trim()
);

if (missingEnvironmentVariables.length > 0) {
  console.error(
    `Startup configuration error: missing required environment variable(s): ${missingEnvironmentVariables.join(", ")}`
  );
  process.exit(1);
}

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

async function connectToRedis() {
  try {
    await redisClient.connect();
    console.log("Connected to Redis");
  } catch (err) {
    console.error("Unable to connect to Redis at startup:", err);
  }
}

connectToRedis();

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/health", (req, res) => {
  const redisConnected = redisClient.isReady;

  res.status(redisConnected ? 200 : 503).json({
    status: redisConnected ? "ok" : "degraded",
    application: "running",
    redis: redisConnected ? "connected" : "disconnected"
  });
});

/* =========================
   TWILIO WEBHOOK
========================= */

app.post("/twilio", async (req, res) => {

  try {

    if (!redisClient.isReady) {
      console.error("Twilio webhook rejected because Redis is unavailable");
      return res.status(503).type("text/xml").send("<Response></Response>");
    }

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
          "🚨 Emergency request selected.\n\n" +
          "Please briefly describe what has happened and where the problem is."
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
          "🔧 Non-urgent repair selected.\n\n" +
          "Please briefly describe the issue and where the problem is."
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
          ? "💷 Quote request selected.\n\n" +
            "Please send a description of the work you'd like a quote for. " +
            "You can also send photos of the issue."
          : "💷 Quote request selected.\n\n" +
            "Please send a description of the work you'd like a quote for."
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
          `🚨 NEW EMERGENCY LEAD\n\n` +
          `📞 Customer: ${from}\n` +
          `🔧 Issue:\n${body}\n\n` +
          `⚠️ Priority: EMERGENCY\n\n` +
          `Customer has been informed that you've been alerted.`
      });

      await redisClient.del(from);

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Thanks, we've received your emergency request. 🚨\n\n" +
          "We've sent the details of the issue, along with your contact " +
          "number, directly to the plumber and they've been alerted.\n\n" +
          "They'll review the information and contact you as soon as possible.\n\n" +
          "If the situation is getting worse or presents an immediate danger, " +
          "please take appropriate action to keep yourself safe."
      });

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
          `🔧 NEW NON-URGENT LEAD\n\n` +
          `📞 Customer: ${from}\n` +
          `🔧 Issue:\n${body}\n\n` +
          `📋 Priority: NON-URGENT\n\n` +
          `Customer has been informed that you've received the details.`
      });

      await redisClient.del(from);

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Thanks, we've got the details. 👍\n\n" +
          "We've passed your issue and contact details directly to the " +
          "plumber, and they've been notified of your request.\n\n" +
          "They'll review the problem and get back to you to discuss the next steps.\n\n" +
          "You don't need to do anything else for now."
      });

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
          `💷 NEW QUOTE REQUEST\n\n` +
          `📞 Customer: ${from}\n` +
          `🔧 Details:\n${body}\n\n` +
          `📋 Request: QUOTE\n\n` +
          `Customer has been informed that you've received the request.`
      });

      await redisClient.del(from);

      await client.messages.create({
        from: to,
        to: from,
        body:
          "Thanks, we've received your quote request. 👍\n\n" +
          "We've sent the details you've provided, along with your contact " +
          "number, directly to the plumber.\n\n" +
          "They've been alerted and will review the information before getting back to you.\n\n" +
          "If they need any additional information before providing a quote, " +
          "they'll contact you directly."
      });

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
