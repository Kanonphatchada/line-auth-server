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

// (debug routes ที่ใช้ทดสอบ Error/ErrorTime integration ถูกลบออกแล้ว —
// ทดสอบผ่านครบทุกเคสแล้ว ดู commit history ของ render-cron ถ้าต้องดูย้อนหลัง)

/* =====================================================
   ยกเลิกการผูกอุปกรณ์ (unclaim) — ทำผ่าน route นี้ด้วย Admin SDK แทนที่จะ
   เปิด Firestore rule ให้ client เคลียร์ uid/ownerUid เองได้ตรงๆ (ซึ่งต้อง
   แก้ rule เพิ่ม เสี่ยงกระทบ path อื่นที่ฮาร์ดแวร์ใช้อยู่โดยไม่ตั้งใจ) ยืนยัน
   ตัวตนผู้เรียกด้วย Firebase ID token (ออกให้ตอน login)

   สำคัญ: รับ nanoId (อุปกรณ์ตัวเดียว) ไม่ใช่ groupId — เพราะหลายอุปกรณ์อยู่
   groupId เดียวกันได้ (เช่น 1 ฟาร์มมีหลายเซนเซอร์) ถ้าเคลียร์ทั้ง groupId
   จะลบความเป็นเจ้าของอุปกรณ์ตัวอื่นในกลุ่มเดียวกันไปด้วยหมด (บั๊กที่เคย
   เกิดขึ้นจริงมาก่อน) เลยเคลียร์แค่ uid ของ ESP32 doc ตัวที่ระบุเท่านั้น
   ส่วน device_registry.ownerUid จะเคลียร์ก็ต่อเมื่อไม่เหลืออุปกรณ์อื่นของ
   เจ้าของคนนี้ในกลุ่มเดียวกันแล้วเท่านั้น (กันไม่ให้กลุ่มถูกปลดล็อกทั้งที่
   ยังมีอุปกรณ์อื่นผูกอยู่)
===================================================== */
app.post("/unclaim-device", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!idToken) {
    return res.status(401).send("Unauthorized");
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return res.status(401).send("Unauthorized");
  }

  const { nanoId } = req.body;
  if (!nanoId) {
    return res.status(400).send("Missing nanoId");
  }

  try {
    const nanoRef = admin.firestore().collection("ESP32").doc(nanoId);
    const nanoDoc = await nanoRef.get();

    if (!nanoDoc.exists || nanoDoc.data().uid !== uid) {
      return res.status(403).send("Forbidden");
    }

    const groupId = nanoDoc.data().groupId;
    const batch = admin.firestore().batch();
    batch.update(nanoRef, { uid: admin.firestore.FieldValue.delete() });

    if (groupId) {
      const siblingsSnap = await admin
        .firestore()
        .collection("ESP32")
        .where("groupId", "==", groupId)
        .where("uid", "==", uid)
        .get();
      const hasOtherOwnedDevices = siblingsSnap.docs.some(
        (d) => d.id !== nanoId
      );

      if (!hasOtherOwnedDevices) {
        const registryRef = admin
          .firestore()
          .collection("device_registry")
          .doc(groupId);
        batch.update(registryRef, { ownerUid: null });
      }
    }

    await batch.commit();

    console.log(`✅ ยกเลิกการผูกอุปกรณ์ ${nanoId} โดย ${uid}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ unclaim-device error:", err);
    res.status(500).send("Error");
  }
});
