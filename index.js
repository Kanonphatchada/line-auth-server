import express from "express";
import axios from "axios";
import querystring from "querystring";

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 ใส่ค่า Channel ID และ Secret ของคุณตรงนี้
const CLIENT_ID = "2005917411";
const CLIENT_SECRET = "d81eb9578665b67a9505ef70fd188c12";
const REDIRECT_URI = "https://line-auth-server.onrender.com/line_login_callback";

app.get("/", (req, res) => {
  res.send("LINE Auth Server is running 🚀");
});

// 🔹 1. เริ่มต้นการ login
app.get("/login", (req, res) => {
  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&state=12345abcde&scope=openid%20profile%20email`;
  res.redirect(authUrl);
});

// 🔹 2. รับ Callback หลังผู้ใช้ login สำเร็จ
app.get("/line_login_callback", async (req, res) => {
  const code = req.query.code;
  try {
    const tokenResponse = await axios.post(
      "https://api.line.me/oauth2/v2.1/token",
      querystring.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const userResponse = await axios.get("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
    });

    res.send(`<h2>Login Success ✅</h2><p>Welcome, ${userResponse.data.displayName}</p>`);
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    res.status(500).send("Login failed ❌");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
