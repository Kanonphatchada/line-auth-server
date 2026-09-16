import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.FIREBASE_KEY) {
  throw new Error("❌ FIREBASE_KEY is not set");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  });
}

const db = admin.firestore();

// อุปกรณ์ควรรายงานค่าเข้ามาสม่ำเสมอ (ทุก 5 นาทีตามสเปกจริง) ถ้าเงียบไปนาน
// ผิดปกติ น่าจะพัง/หลุดการเชื่อมต่อ
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 นาที

// เซ็นเซอร์ RS485 รายงานเป็น % ความชื้น มาตรฐานเดียวกันทุกตัว ความคลาดเคลื่อน
// ของตัวเซ็นเซอร์เองอยู่ที่ ~±2-3% ตามสเปก เลยตั้งพื้นที่ให้ถือว่า "ค่านิ่ง"
// ถ้าเปลี่ยนไม่เกินนี้ กันสัญญาณรบกวนเล็กๆ ทำให้แจ้งเตือนผิด (false alarm)
const MOISTURE_NOISE_FLOOR_PERCENT = 3;

// ต้องรอให้คำสั่งวาล์วนิ่ง (ไม่เพิ่งสั่งเปลี่ยน) มานานพอจะดูแนวโน้มได้จริง
const VALVE_STABLE_MS = 30 * 60 * 1000; // 30 นาที

// สคริปต์นี้แทนที่ Cloud Functions ทั้ง 4 ตัวที่เขียนไว้ก่อนหน้า (ซึ่ง deploy
// ไม่ได้เพราะโปรเจกต์ยังอยู่ Firebase plan ฟรี) — ทำงานแบบ "โพล" (เรียกเป็น
// รอบๆ ผ่าน Render Cron Job) แทนแบบ trigger เรียลไทม์ ไม่ต้องใช้ Blaze plan
// เลย เพราะรันบน Render ด้วย Admin SDK ตรงๆ เหมือนกับ /update route เดิม
async function checkDevices() {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db.collection("ESP32").get();

  let assigned = 0;
  let offlineFlagged = 0;
  let onlineCleared = 0;
  let faultsFlagged = 0;
  let faultsCleared = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const updates = {};

    // 1) ผูก uid ให้อุปกรณ์ใหม่ที่กลุ่มถูก claim ไปแล้ว (แทน autoAssignDeviceOwner เดิม)
    if (!data.uid && data.groupId) {
      const registryDoc = await db
        .collection("device_registry")
        .doc(data.groupId)
        .get();
      const ownerUid = registryDoc.exists ? registryDoc.data().ownerUid : null;
      if (ownerUid) {
        updates.uid = ownerUid;
        assigned++;
      }
    }

    // 2) เช็คว่ารายงานล่าสุดเมื่อไหร่ จาก log ล่าสุด (แทน lastSeen เดิม)
    const lastLogSnap = await doc.ref
      .collection("Logs")
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    const lastSeenMs = lastLogSnap.empty
      ? null
      : (lastLogSnap.docs[0].data().timestamp?.toMillis?.() ?? null);

    const isStale =
      lastSeenMs === null ||
      now.toMillis() - lastSeenMs > OFFLINE_THRESHOLD_MS;

    if (isStale && data.offline !== true) {
      updates.offline = true;
      offlineFlagged++;
    } else if (!isStale && data.offline === true) {
      updates.offline = false;
      onlineCleared++;
    }

    // 3) เช็คว่า Valve เปลี่ยนสถานะไปจากรอบที่แล้วไหม (เทียบกับค่าที่จำไว้
    //    ตอนโพลรอบก่อน) ถ้าเปลี่ยน บันทึกเวลาไว้ก่อน ยังตัดสินไม่ได้รอบนี้
    //    ต้องรอให้นิ่งครบ VALVE_STABLE_MS ก่อนถึงจะดูแนวโน้มความชื้นได้
    const valveIsOpen = data.Valve === true;
    const valveJustChanged = data._lastCheckedValve !== valveIsOpen;
    const valveChangedAtMs = data.valveChangedAt?.toMillis?.() ?? 0;

    if (valveJustChanged) {
      updates.valveChangedAt = admin.firestore.FieldValue.serverTimestamp();
      updates._lastCheckedValve = valveIsOpen;
    }

    const canJudgeValve =
      !valveJustChanged &&
      valveChangedAtMs > 0 &&
      now.toMillis() - valveChangedAtMs >= VALVE_STABLE_MS;

    if (isStale) {
      // ขาดการติดต่ออยู่แล้ว ไม่ต้องซ้ำเรื่องวาล์ว เคลียร์ป้ายวาล์วทิ้งไปก่อน
      if (data.faultType) {
        updates.faultType = admin.firestore.FieldValue.delete();
        faultsCleared++;
      }
    } else if (canJudgeValve) {
      const logsSnap = await doc.ref
        .collection("Logs")
        .where(
          "timestamp",
          ">=",
          admin.firestore.Timestamp.fromMillis(
            now.toMillis() - VALVE_STABLE_MS
          )
        )
        .orderBy("timestamp", "asc")
        .get();

      const readings = logsSnap.docs
        .map((d) => d.data().moisture)
        .filter((m) => typeof m === "number");

      if (readings.length >= 2) {
        const delta = readings[readings.length - 1] - readings[0];

        let faultType = null;
        if (!valveIsOpen && delta > MOISTURE_NOISE_FLOOR_PERCENT) {
          faultType = "valve_stuck_open";
        } else if (valveIsOpen && delta < MOISTURE_NOISE_FLOOR_PERCENT) {
          faultType = "valve_no_flow";
        }

        const currentFault = data.faultType || null;
        if (currentFault !== faultType) {
          updates.faultType = faultType
            ? faultType
            : admin.firestore.FieldValue.delete();
          if (faultType) {
            faultsFlagged++;
          } else {
            faultsCleared++;
          }
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await doc.ref.update(updates);
    }
  }

  console.log(
    `✅ checkDevices: ${snapshot.size} devices scanned | assigned=${assigned} offlineFlagged=${offlineFlagged} onlineCleared=${onlineCleared} faultsFlagged=${faultsFlagged} faultsCleared=${faultsCleared}`
  );
}

checkDevices()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ checkDevices failed:", err);
    process.exit(1);
  });
