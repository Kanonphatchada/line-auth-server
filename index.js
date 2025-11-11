import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ทดสอบว่าเซิร์ฟเวอร์รันได้
app.get("/", (req, res) => {
  res.send("✅ LINE Auth Server is running!");
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
