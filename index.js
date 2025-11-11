import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import admin from "firebase-admin";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);


const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());


// --------------------------------------------
// LINE Login Route
// --------------------------------------------
app.get("/login", (req, res) => {
  const clientId = "2005917411"; // 🔹 ใส่ Channel ID ของคุณ
  const redirectUri = "https://line-auth-server.onrender.com/callback"; // 🔹 ต้องตรงกับ LINE Console
  const state = "test123"; // ใช้ตรวจสอบความถูกต้องตอน callback

  const lineLoginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&state=${state}&scope=profile%20openid%20email`;

  res.redirect(lineLoginUrl);
});

// --------------------------------------------
// LINE Callback Route
// --------------------------------------------
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  const tokenUrl = "https://api.line.me/oauth2/v2.1/token";
  const clientId = "2005917411"; // 🔹 Channel ID
  const clientSecret = "d81eb9578665b67a9505ef70fd188c12"; // 🔹 Channel Secret
  const redirectUri = "https://line-auth-server.onrender.com/callback";

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res
        .status(400)
        .send(`LINE Login Error: ${data.error_description}`);
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
      },
    });

    const profile = await profileResponse.json();

    // ✅ ตอนนี้ได้ข้อมูลผู้ใช้แล้ว เช่น displayName, userId, pictureUrl
    console.log("User Profile:", profile);

    res.send(`
      <h2>✅ Login successful!</h2>
      <p>Name: ${profile.displayName}</p>
      <img src="${profile.pictureUrl}" width="100">
      <p>UserID: ${profile.userId}</p>
    `);
  } catch (error) {
    console.error("Error during LINE Login:", error);
    res.status(500).send("Internal Server Error");
  }
});

// --------------------------------------------
// Firebase (for later use)
// --------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// --------------------------------------------
// Default Route
// --------------------------------------------
app.get("/", (req, res) => {
  res.send("✅ LINE Auth Server is running!");
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
