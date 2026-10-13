const express = require("express");
const twilio = require("twilio");
const redis = require("redis");

const app = express();

app.use(express.urlencoded({ extended: false }));

if (!process.env.TWILIO_WEBHOOK_URL) {
  console.warn("TWILIO_WEBHOOK_URL is not configured; /twilio requests will be rejected");
}

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PLUMBER_PHONE_NUMBER,
  TWILIO_US_NUMBER,
  TWILIO_UK_NUMBER,
  REDIS_URL,
  TENANT_CONFIG_JSON,
  TWILIO_WEBHOOK_URL
} = process.env;

const requiredEnvironmentVariables = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
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
   TENANT CONFIGURATION
========================= */

function normalizePhoneNumber(value) {
  return typeof value === "string"
    ? value.trim().replace(/[^\d+]/g, "")
    : "";
}

function isValidE164PhoneNumber(value) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

let tenantConfigs = null;

if (TENANT_CONFIG_JSON && TENANT_CONFIG_JSON.trim()) {
  try {
    const parsedTenantConfigs = JSON.parse(TENANT_CONFIG_JSON);

    if (
      !parsedTenantConfigs ||
      typeof parsedTenantConfigs !== "object" ||
      Array.isArray(parsedTenantConfigs)
    ) {
      throw new Error("Tenant configuration must be a JSON object");
    }

    tenantConfigs = new Map();

    for (const [twilioNumber, config] of Object.entries(parsedTenantConfigs)) {
      const normalizedTwilioNumber = normalizePhoneNumber(twilioNumber);
      const plumberPhoneNumber = normalizePhoneNumber(config?.plumberPhoneNumber);

      if (
        !isValidE164PhoneNumber(normalizedTwilioNumber) ||
        !isValidE164PhoneNumber(plumberPhoneNumber)
      ) {
        throw new Error(
          "Each tenant must have valid E.164 Twilio and plumber phone numbers"
        );
      }

      if (config.region !== "US" && config.region !== "UK") {
        throw new Error('Each tenant region must be exactly "US" or "UK"');
      }

      tenantConfigs.set(normalizedTwilioNumber, {
        plumberPhoneNumber,
        region: config.region
      });
    }

    if (tenantConfigs.size === 0) {
      throw new Error("At least one tenant must be configured");
    }
  } catch (err) {
    console.error("Startup configuration error: invalid TENANT_CONFIG_JSON:", err.message);
    process.exit(1);
  }
}

function getTenantConfig(twilioNumber) {
  const normalizedTwilioNumber = normalizePhoneNumber(twilioNumber);

  if (tenantConfigs) {
    return tenantConfigs.get(normalizedTwilioNumber) || null;
  }

  // Backwards-compatible single-plumber configuration.
  if (
    normalizedTwilioNumber === normalizePhoneNumber(TWILIO_US_NUMBER) ||
    (TWILIO_UK_NUMBER &&
      normalizedTwilioNumber === normalizePhoneNumber(TWILIO_UK_NUMBER))
  ) {
    return {
      plumberPhoneNumber: PLUMBER_PHONE_NUMBER,
      region: normalizedTwilioNumber === normalizePhoneNumber(TWILIO_US_NUMBER)
        ? "US"
        : "UK"
    };
  }

  return null;
}

if (!tenantConfigs) {
  const missingLegacyConfig = [];

  if (!isValidE164PhoneNumber(normalizePhoneNumber(TWILIO_US_NUMBER))) {
    missingLegacyConfig.push("TWILIO_US_NUMBER");
  }

  if (!isValidE164PhoneNumber(normalizePhoneNumber(PLUMBER_PHONE_NUMBER))) {
    missingLegacyConfig.push("PLUMBER_PHONE_NUMBER");
  }

  if (missingLegacyConfig.length > 0) {
    console.error(
      "Startup configuration error: valid E.164 value(s) required when TENANT_CONFIG_JSON is not configured: " +
      missingLegacyConfig.join(", ")
    );
    process.exit(1);
  }
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

    // Signature validation is mandatory in production. The configured URL must
    // exactly match the public URL configured in Twilio, including scheme and path.
    if (!TWILIO_WEBHOOK_URL) {
      console.error("Twilio webhook unavailable: TWILIO_WEBHOOK_URL is not configured");
      return res.status(503).type("text/xml").send("<Response></Response>");
    }

    const signature = req.get("X-Twilio-Signature") || "";
    const signatureIsValid = twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      signature,
      TWILIO_WEBHOOK_URL,
      req.body
    );

    if (!signatureIsValid) {
      console.warn("Twilio webhook rejected: signature validation failed");
      return res.status(403).type("text/xml").send("<Response></Response>");
    }

    if (!redisClient.isReady) {
      console.error("Twilio webhook rejected because Redis is unavailable");
      return res.status(503).type("text/xml").send("<Response></Response>");
    }

    // Twilio retries webhook deliveries. Use MessageSid to suppress duplicate processing.
    const messageSid = typeof req.body.MessageSid === "string"
      ? req.body.MessageSid.trim()
      : "";

    if (messageSid) {
      const idempotencyKey = `twilio:message:${messageSid}`;
      const lockAcquired = await redisClient.set(idempotencyKey, "processing", {
        NX: true,
        EX: 120
      });

      if (lockAcquired !== "OK") {
        const existingStatus = await redisClient.get(idempotencyKey);

        if (existingStatus === "completed" || existingStatus === "processing") {
          console.log("Duplicate Twilio webhook delivery ignored");
          return res.status(200).type("text/xml").send("<Response></Response>");
        }

        // The key may have expired between SET NX and GET; reacquire before processing.
        const retryLockAcquired = await redisClient.set(idempotencyKey, "processing", {
          NX: true,
          EX: 120
        });

        if (retryLockAcquired !== "OK") {
          return res.status(503).type("text/xml").send("<Response></Response>");
        }
      }

      // Mark successful HTTP responses as completed; allow retries after server errors.
      res.once("finish", () => {
        const updateIdempotencyState = res.statusCode >= 500
          ? redisClient.del(idempotencyKey)
          : redisClient.set(idempotencyKey, "completed", { EX: 604800 });

        updateIdempotencyState.catch((err) => {
          console.error("Unable to update webhook idempotency state:", err.message);
        });
      });
    }

    const from = req.body.From;
    const to = req.body.To;
    const body = typeof req.body.Body === "string" ? req.body.Body : "";
    const parsedNumMedia = Number.parseInt(req.body.NumMedia || "0", 10);
    const numMedia = Number.isInteger(parsedNumMedia) && parsedNumMedia > 0
      ? Math.min(parsedNumMedia, 10)
      : 0;

    // Reject malformed webhook payloads before touching Redis or sending messages.
    const normalizedFrom = normalizePhoneNumber(from);
    const normalizedTo = normalizePhoneNumber(to);

    if (!normalizedFrom || !normalizedTo || !normalizedFrom.startsWith("+") || !normalizedTo.startsWith("+")) {
      console.warn("Twilio webhook rejected: missing or invalid From/To number");
      return res.status(400).type("text/xml").send("<Response></Response>");
    }

    const incomingMsg = body.trim().toLowerCase();

    // Scope each conversation to both the customer and the Twilio number.
    const tenantConfig = getTenantConfig(normalizedTo);

    if (!tenantConfig) {
      console.error("Twilio webhook rejected: no tenant configured for receiving number");
      return res.status(404).type("text/xml").send("<Response></Response>");
    }

    const stateKey = `conversation:${normalizedTo}:${normalizedFrom}`;
    const state = await redisClient.get(stateKey);

    const plumberPhoneNumber = tenantConfig.plumberPhoneNumber;
    const isUSNumber = tenantConfig.region === "US";

    /* =========================
       LOGGING
    ========================== */

    // Avoid logging customer phone numbers, message contents, or conversation state.
    console.log("Incoming Twilio message accepted for configured tenant");
    console.log("Media count:", numMedia);
    console.log("Conversation state:", state || "none");

    /* =========================
       STOP / CANCEL
    ========================== */

    if (
      incomingMsg === "stop" ||
      incomingMsg === "cancel" ||
      incomingMsg === "exit"
    ) {

      await redisClient.del(stateKey);

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
        to: plumberPhoneNumber,
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

    if (incomingMsg === "yes" && !state) {

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

    if (incomingMsg === "1" && !state) {

      await redisClient.set(
        stateKey,
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

    if (incomingMsg === "2" && !state) {

      await redisClient.set(
        stateKey,
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

    if (incomingMsg === "3" && !state) {

      await redisClient.set(
        stateKey,
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
        to: plumberPhoneNumber,
        body:
          `🚨 NEW EMERGENCY LEAD\n\n` +
          `📞 Customer: ${from}\n` +
          `🔧 Issue:\n${body}\n\n` +
          `⚠️ Priority: EMERGENCY\n\n` +
          `Customer has been informed that you've been alerted.`
      });

      await redisClient.del(stateKey);

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
        to: plumberPhoneNumber,
        body:
          `🔧 NEW NON-URGENT LEAD\n\n` +
          `📞 Customer: ${from}\n` +
          `🔧 Issue:\n${body}\n\n` +
          `📋 Priority: NON-URGENT\n\n` +
          `Customer has been informed that you've received the details.`
      });

      await redisClient.del(stateKey);

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
        to: plumberPhoneNumber,
        body:
          `💷 NEW QUOTE REQUEST\n\n` +
          `📞 Customer: ${from}\n` +
          `🔧 Details:\n${body}\n\n` +
          `📋 Request: QUOTE\n\n` +
          `Customer has been informed that you've received the request.`
      });

      await redisClient.del(stateKey);

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
      to: plumberPhoneNumber,
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

    console.error("Webhook processing error:", err.message);

    // A non-2xx response makes delivery failure visible to Twilio and monitoring.
    res.status(500).type("text/xml").send("<Response></Response>");
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
