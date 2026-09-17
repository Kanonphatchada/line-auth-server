import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";
import { checkDevices } from "./checkDevices.js";

dotenv.config();

/* ================= Firebase Admin ================= */
if (!process.env.FIREBASE_KEY) {
  throw new Error("❌ FIREBASE_KEY is not set");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* ================= Express ================= */
const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

/* ================= LOGIN ================= */
app.get("/login", (req, res) => {
  const clientId = process.env.LINE_CLIENT_ID;
  const redirectUri = process.env.LINE_CALLBACK_URL;

  const state = "state_" + Date.now();

  const url =
    `https://access.line.me/oauth2/v2.1/authorize` +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&scope=profile%20openid%20email`;

  res.redirect(url);
});

/* ================= CALLBACK ================= */
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("❌ No code");
  }
  try {
    /* ---------- 1. แลก token ---------- */
    const tokenResp = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.LINE_CALLBACK_URL,
        client_id: process.env.LINE_CLIENT_ID,
        client_secret: process.env.LINE_CLIENT_SECRET,
      }),
    });

    const tokenData = await tokenResp.json();

    /* ---------- 2. ดึง profile ---------- */
    const profileResp = await fetch("https://api.line.me/v2/profile", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const profile = await profileResp.json();
    console.log("✅ LINE:", profile);

    const lineUserId = profile.userId;
    const fakeEmail = `${lineUserId}@line.com`;

    let user;

    try {
      user = await admin.auth().getUserByEmail(fakeEmail);
    } catch {
      user = await admin.auth().createUser({
        email: fakeEmail,
        password: "12345678",
      });
    }

    const firebaseUid = user.uid;

    console.log("🔥 Firebase UID:", firebaseUid);

    /* ---------- 3. สร้าง Custom Token ---------- */
    const firebaseToken = await admin.auth().createCustomToken(firebaseUid);

    /* ---------- 4. Save user ---------- */
    await admin.firestore().collection("users").doc(firebaseUid).set(
      {
        uid: firebaseUid, // 🔥 ตัวจริง
        lineUserId: lineUserId, // 🔥 เก็บไว้ map
        displayName: profile.displayName || null,
        pictureUrl: profile.pictureUrl || null,
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    /* ---------- 5. Redirect ---------- */
    const redirectUrl =
      `${process.env.FRONTEND_URL}?firebaseToken=${firebaseToken}`;

    res.redirect(redirectUrl);
  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).send("Error");
  }
});

/* ================= RUN ================= */
app.listen(port, () => {
  console.log("🚀 Server running on port", port);
})
/* =====================================================
   ESP32 Update Route
===================================================== */
app.post("/update", async (req, res) => {
  try {
    const { nano, Moisture, Valve, Auto, Time } = req.body;

    console.log("🔥 BODY:", req.body);

    if (!nano) {
      return res.status(400).send("Missing nano id");
    }

    await admin.firestore().collection("ESP32").doc(nano).set(
      {
        Moisture: Moisture ?? 0,
        Valve: Valve ?? false,
        Auto: Auto ?? false,
        Time: Time ?? "",
        // ใช้เช็คว่าอุปกรณ์ขาดการติดต่อไปหรือยัง (ดู checkDevices.js) —
        // ประทับตรงนี้เพราะ route นี้ไม่ได้เขียนลง Logs subcollection เลย
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`✅ Updated ${nano}`);

    res.send("OK");
  } catch (err) {
    console.error("❌ ESP32 Update Error:", err);
    res.status(500).send("Error");
  }
});

/* =====================================================
   Device health check — เรียกโดย cron ภายนอกฟรี (เช่น cron-job.org)
   ทุก 10-15 นาที แทนการใช้ Firebase Cloud Functions ที่ต้อง Blaze plan
===================================================== */
app.get("/cron/check-devices", async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const summary = await checkDevices();
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error("❌ checkDevices error:", err);
    res.status(500).send("Error");
  }
});
