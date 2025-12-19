import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

/* =====================================================
   Firebase Admin (ต้อง init ก่อนใช้ admin.auth())
===================================================== */
if (!process.env.FIREBASE_KEY) {
  throw new Error("❌ FIREBASE_KEY is not set in environment variables");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* =====================================================
   Express App
===================================================== */
const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

/* =====================================================
   LINE Login Route
===================================================== */
app.get("/login", (req, res) => {
  const clientId = process.env.LINE_CLIENT_ID || "2005917411";
  const redirectUri =
    process.env.LINE_CALLBACK_URL ||
    "https://line-auth-server.onrender.com/callback";

  const state = "state_" + Date.now();

  const loginUrl =
    `https://access.line.me/oauth2/v2.1/authorize` +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&scope=profile%20openid%20email`;

  return res.redirect(loginUrl);
});

/* =====================================================
   LINE Callback Route
===================================================== */
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("❌ Missing authorization code");
  }

  const tokenUrl = "https://api.line.me/oauth2/v2.1/token";
  const clientId = process.env.LINE_CLIENT_ID;
  const clientSecret = process.env.LINE_CLIENT_SECRET;
  const redirectUri = process.env.LINE_CALLBACK_URL;

  try {
    /* ---------- แลก code เป็น access_token ---------- */
    const tokenResp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const tokenData = await tokenResp.json();

    if (tokenData.error) {
      console.error("LINE token error:", tokenData);
      return res
        .status(400)
        .send("LINE token error: " + tokenData.error_description);
    }

    /* ---------- ดึง LINE profile ---------- */
    const profileResp = await fetch("https://api.line.me/v2/profile", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const profile = await profileResp.json();
    console.log("✅ LINE Profile:", profile);

    /* ---------- สร้าง Firebase Custom Token ---------- */
    const uid = `line:${profile.userId}`;
    const firebaseToken = await admin.auth().createCustomToken(uid);

    /* ---------- บันทึก user ลง Firestore (optional แต่แนะนำ) ---------- */
    await admin.firestore().collection("users").doc(uid).set(
      {
        uid,
        lineUserId: profile.userId,
        displayName: profile.displayName || null,
        pictureUrl: profile.pictureUrl || null,
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    /* ---------- Redirect กลับ Flutter Web ---------- */
    const frontend =
      process.env.FRONTEND_URL || "http://localhost:59812";

    const redirectUrl =
      `${frontend}?firebaseToken=${encodeURIComponent(firebaseToken)}` +
      `&displayName=${encodeURIComponent(profile.displayName || "")}`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("❌ Callback error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

/* =====================================================
   Health Check
===================================================== */
app.get("/", (req, res) => {
  res.send("✅ LINE Auth Server is running!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
