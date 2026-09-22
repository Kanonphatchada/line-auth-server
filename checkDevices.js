import admin from "firebase-admin";
import fetch from "node-fetch";

// ไม่เรียก admin.initializeApp() ในไฟล์นี้ — ฟังก์ชันนี้ถูก import เข้าไปใช้
// ใน index.js ซึ่ง initialize แอปไว้แล้วตั้งแต่ตอนเริ่มเซิร์ฟเวอร์

// ส่งข้อความแจ้งเตือนไปหาเจ้าของอุปกรณ์ผ่าน LINE Messaging API — ใช้
// lineUserId ที่เก็บไว้ตอน login แล้ว (users/{uid}.lineUserId) ไม่ต้องสร้าง
// ระบบ map ผู้ใช้ใหม่ ถ้ายังไม่ได้ตั้ง LINE_MESSAGING_TOKEN หรือหา
// lineUserId ไม่เจอ จะข้ามไปเงียบๆ ไม่ทำให้ checkDevices ทั้งรอบพัง
//
// category เป็น "offline" หรือ "fault" — เอาไว้เช็คว่าผู้ใช้ปิดการแจ้งเตือน
// ประเภทนั้นไว้หรือเปล่า (users/{uid}.notifyOffline / .notifyFault) ถ้ายังไม่
// เคยตั้งค่าไว้เลย (undefined) ถือว่าเปิดรับไว้ก่อน ไม่ให้ผู้ใช้เดิมที่ไม่เคย
// ตั้งค่าอะไรหยุดได้รับแจ้งเตือนไปเฉยๆ
async function sendLineAlert(uid, text, category) {
  if (!process.env.LINE_MESSAGING_TOKEN) {
    return;
  }

  try {
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return;
    }

    const userData = userDoc.data();
    const lineUserId = userData.lineUserId;

    if (!lineUserId) {
      return;
    }

    const prefField = category === "offline" ? "notifyOffline" : "notifyFault";
    if (userData[prefField] === false) {
      return;
    }

    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_MESSAGING_TOKEN}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: "text", text }],
      }),
    });

    if (!res.ok) {
      console.error("❌ LINE push failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("❌ sendLineAlert error:", err);
  }
}

// เปิด incident ใหม่ใน ESP32/{nanoId}/Incidents ไว้เป็นประวัติถาวร (แยกจาก
// field offline/faultType ที่บอกแค่สถานะปัจจุบัน) ให้หน้า History เอาไปนับ
// จำนวนครั้ง/สาเหตุ/ช่วงเวลาที่พังย้อนหลังได้ — คืน id ของ incident ที่เปิด
// ไว้ เก็บไว้บน ESP32 doc เอง จะได้รู้ว่าต้องปิด incident ไหนตอนหายแล้ว
async function openIncident(doc, type, cause) {
  const ref = doc.ref.collection("Incidents").doc();
  await ref.set({
    type,
    cause,
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedAt: null,
  });
  return ref.id;
}

async function closeIncident(doc, incidentId) {
  if (!incidentId) return;
  await doc.ref
    .collection("Incidents")
    .doc(incidentId)
    .update({ resolvedAt: admin.firestore.FieldValue.serverTimestamp() })
    .catch((err) => console.error("❌ closeIncident error:", err));
}

// อุปกรณ์ควรรายงานค่าเข้ามาสม่ำเสมอ (ทุก 5 นาทีตามสเปกจริง) ถ้าเงียบไปนาน
// ผิดปกติ น่าจะพัง/หลุดการเชื่อมต่อ
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 นาที

// เซ็นเซอร์ RS485 รายงานเป็น % ความชื้น มาตรฐานเดียวกันทุกตัว ความคลาดเคลื่อน
// ของตัวเซ็นเซอร์เองอยู่ที่ ~±2-3% ตามสเปก เลยตั้งพื้นที่ให้ถือว่า "ค่านิ่ง"
// ถ้าเปลี่ยนไม่เกินนี้ กันสัญญาณรบกวนเล็กๆ ทำให้แจ้งเตือนผิด (false alarm)
const MOISTURE_NOISE_FLOOR_PERCENT = 3;

// ต้องรอให้คำสั่งวาล์วนิ่ง (ไม่เพิ่งสั่งเปลี่ยน) มานานพอจะดูแนวโน้มได้จริง
const VALVE_STABLE_MS = 30 * 60 * 1000; // 30 นาที

// error ที่ firmware ของเพื่อน (Nano → ESP32 → Firebase) เขียนตรงๆ ลง field
// Error/ErrorTime บนตัว ESP32 doc — map ข้อความไปเป็น incident type/label ของ
// เรา ไม่รวม "WiFi Disconnected" (errorCode -1) เพราะเพื่อนยืนยันว่าเคสนี้
// ไม่มีทางส่งค่าขึ้น Firestore ได้จริง (ตอน WiFi หลุดคือตอนที่ส่งอะไรขึ้น
// Firebase ไม่ได้เลยพอดี) ใส่ไว้ในนี้ก็จะไม่มีวันถูกจับได้อยู่ดี
const FIRMWARE_ERROR_TYPES = {
  "Sensor Read Error": {
    type: "sensor_error",
    label: "เซนเซอร์อ่านค่าความชื้นไม่สำเร็จ (รายงานจากอุปกรณ์)",
  },
  "Nano Not Responding": {
    type: "nano_error",
    label: "ESP32 ติดต่อ Nano ไม่ได้ (รายงานจากอุปกรณ์)",
  },
  "Valve ON but moisture not rising": {
    type: "valve_no_flow",
    label: "เปิดวาล์วแล้วความชื้นไม่ขึ้นภายใน 2 นาที (รายงานจากอุปกรณ์)",
  },
};

// เช็คว่าตอนนี้อยู่ในช่วงเวลาที่อนุญาตให้รดน้ำอัตโนมัติไหม (ฟีเจอร์ตั้งเวลา
// รดน้ำ) — รับ "HH:mm" สองค่า รองรับช่วงข้ามเที่ยงคืนด้วย (เช่น 22:00-06:00)
// ใช้เวลาไทย (UTC+7) เสมอไม่ว่า server จะตั้ง timezone เป็นอะไรก็ตาม เพราะ
// Render ไม่รับประกันว่า timezone ของเครื่องจะเป็นอะไร
function isWithinScheduleWindow(startHHmm, endHHmm) {
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  const nowBangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const nowMinutes = nowBangkok.getUTCHours() * 60 + nowBangkok.getUTCMinutes();

  const startMinutes = toMinutes(startHHmm);
  const endMinutes = toMinutes(endHHmm);

  if (startMinutes === endMinutes) return true; // ตั้งเท่ากันถือว่าเปิดทั้งวัน
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // ช่วงข้ามเที่ยงคืน เช่น 22:00 - 06:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

// หาว่า "ตารางเวลาที่มีผลจริง" ของอุปกรณ์นี้มาจากไหน — ถ้าอุปกรณ์ตั้ง
// scheduleOverride ไว้เอง (true) ใช้ตารางเวลาของตัวเอง ไม่งั้น fallback ไปใช้
// ของกลุ่ม/ฟาร์ม (device_registry) แทน ให้ตั้งครั้งเดียวใช้ได้ทั้งฟาร์มเป็น
// ร้อยอุปกรณ์ ไม่ต้องตั้งทีละตัว — คืน null ถ้าไม่มีตารางเวลาจากที่ไหนเลย
function resolveScheduleSource(data, groupRegistry) {
  if (data.scheduleOverride === true) {
    return {
      scheduleEnabled: data.scheduleEnabled === true,
      scheduleMode: data.scheduleMode,
      scheduleStart: data.scheduleStart,
      scheduleEnd: data.scheduleEnd,
    };
  }
  if (groupRegistry && groupRegistry.scheduleEnabled !== undefined) {
    return {
      scheduleEnabled: groupRegistry.scheduleEnabled === true,
      scheduleMode: groupRegistry.scheduleMode,
      scheduleStart: groupRegistry.scheduleStart,
      scheduleEnd: groupRegistry.scheduleEnd,
    };
  }
  return null;
}

// คำนวณค่า Auto ที่ "ควรจะเป็นจริงๆ" ตอนนี้ — ถ้าไม่มีตารางเวลาที่เปิดใช้อยู่
// เลย (ทั้งระดับอุปกรณ์และระดับกลุ่ม) ให้ใช้ค่า Auto เดิมตรงๆ ไม่ยุ่งเลย
// (ของเดิมทำงานเหมือนเดิม 100%) เปิดใช้ก็ต่อเมื่อผู้ใช้ตั้งค่าไว้ชัดเจน
// เท่านั้น — desiredAuto คือ "ความตั้งใจ" ของผู้ใช้จากสวิตช์ในแอป (เป็นราย
// อุปกรณ์เสมอ แม้จะใช้ตารางเวลาของกลุ่มก็ตาม) ถ้ายังไม่เคยมีค่านี้:
//   - ใช้ตารางเวลาของอุปกรณ์เอง (override) → fallback ไปใช้ค่า Auto ปัจจุบัน
//     (อุปกรณ์เก่าก่อนมีฟีเจอร์นี้ ผู้ใช้ต้องเคยเปิด Auto เองมาก่อน)
//   - ใช้ตารางเวลาของกลุ่ม/ฟาร์ม (ไม่ override) → ถือว่า "ยินยอม" ไปเลย
//     เพราะการเปิดตารางเวลาทั้งฟาร์มคือความตั้งใจของผู้ใช้อยู่แล้วที่จะให้
//     ทุกอุปกรณ์ในฟาร์มรดน้ำตามตาราง ไม่งั้นอุปกรณ์ที่ Auto ปิดอยู่แต่เดิม
//     (ปกติของอุปกรณ์ที่ไม่เคยแตะสวิตช์เลย) จะไม่ขยับตามตารางฟาร์มเลยแม้จะ
//     เปิดใช้ไว้แล้วก็ตาม
//
// scheduleMode มี 2 แบบ:
//   "allow" (default) — รดได้เฉพาะในช่วงเวลานี้เท่านั้น
//   "block"            — รดได้ตลอด ยกเว้นในช่วงเวลานี้ (เช่น เช้า-เย็น
//                        ยกเว้นเที่ยง ก็แค่ตั้ง block 11:00-14:00 ไม่ต้องมี
//                        หลายช่วงเวลาให้ยุ่งยาก)
function computeEffectiveAuto(data, groupRegistry) {
  const usingOwnOverride = data.scheduleOverride === true;
  const schedule = resolveScheduleSource(data, groupRegistry);

  if (!schedule || schedule.scheduleEnabled !== true) {
    return data.Auto === true;
  }
  const desiredAuto =
    data.desiredAuto !== undefined
      ? data.desiredAuto === true
      : usingOwnOverride
      ? data.Auto === true
      : true;
  if (!desiredAuto) return false;
  if (!schedule.scheduleStart || !schedule.scheduleEnd) return desiredAuto;

  const withinWindow = isWithinScheduleWindow(
    schedule.scheduleStart,
    schedule.scheduleEnd
  );
  return schedule.scheduleMode === "block" ? !withinWindow : withinWindow;
}

// ฟังก์ชันนี้แทนที่ Cloud Functions ทั้ง 4 ตัวที่เขียนไว้ก่อนหน้า (ซึ่ง deploy
// ไม่ได้เพราะโปรเจกต์ยังอยู่ Firebase plan ฟรี) — ทำงานแบบ "โพล" เรียกผ่าน
// route /cron/check-devices ใน index.js โดยมี cron ภายนอกฟรียิงเข้ามาเป็น
// รอบๆ แทนแบบ trigger เรียลไทม์ ไม่ต้องใช้ Blaze plan เลย เพราะรันบน Render
// ด้วย Admin SDK ตรงๆ เหมือนกับ /update route เดิม
export async function checkDevices() {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db.collection("ESP32").get();

  // ดึง device_registry มาครั้งเดียวทั้ง collection แล้วทำ map ไว้ในหน่วยความจำ
  // แทนอ่านทีละตัวต่ออุปกรณ์ — จำนวน document ในนี้ผูกกับจำนวน "กลุ่ม/ฟาร์ม"
  // ไม่ใช่จำนวนอุปกรณ์ ต่อให้มีอุปกรณ์เป็นร้อยตัวก็ยังเป็นแค่ไม่กี่สิบกลุ่ม
  // ประหยัด read quota กว่าเยอะ ใช้หาตารางเวลาระดับกลุ่ม/ฟาร์มด้านล่าง
  const registrySnapshot = await db.collection("device_registry").get();
  const registryByGroupId = new Map();
  registrySnapshot.docs.forEach((d) => registryByGroupId.set(d.id, d.data()));

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

    // ตั้งเวลารดน้ำ (opt-in ผ่าน scheduleEnabled ระดับอุปกรณ์ตัวเอง หรือ
    // ระดับกลุ่ม/ฟาร์มที่ device_registry ก็ได้ — ดู resolveScheduleSource)
    // เช็คซ้ำทุกรอบเผื่อข้ามช่วงเวลาไปโดยไม่มีใครแตะสวิตช์เลย (เช่น เข้าสู่
    // ช่วงเวลาเปิดตอนตี 6 เอง) ไม่แตะอุปกรณ์ที่ไม่มีตารางเวลาจากที่ไหนเลย
    // แม้แต่นิดเดียว — computeEffectiveAuto คืนค่าเดิมของ Auto ตรงๆ ในกรณีนั้น
    const groupRegistry = data.groupId
      ? registryByGroupId.get(data.groupId)
      : null;
    const scheduleSource = resolveScheduleSource(data, groupRegistry);
    const effectiveAuto = computeEffectiveAuto(data, groupRegistry);
    if (
      scheduleSource?.scheduleEnabled === true &&
      effectiveAuto !== (data.Auto === true)
    ) {
      updates.Auto = effectiveAuto;
    }

    // 2) เช็คว่ารายงานล่าสุดเมื่อไหร่ — ดูทั้ง field lastSeen บนตัว doc เอง
    //    (ที่ /update ประทับให้ทุกครั้งที่อุปกรณ์รายงานค่า) และ log ล่าสุดใน
    //    Logs (เผื่อบางอุปกรณ์เขียน Firestore ตรงๆ อีกทางที่ไม่ผ่าน /update)
    //    เอาอันที่ใหม่กว่า กันพลาดไม่ว่าอุปกรณ์จะรายงานผ่านทางไหน
    const lastSeenFieldMs = data.lastSeen?.toMillis?.() ?? null;

    const lastLogSnap = await doc.ref
      .collection("Logs")
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    const lastLogMs = lastLogSnap.empty
      ? null
      : (lastLogSnap.docs[0].data().timestamp?.toMillis?.() ?? null);

    const lastSeenMs = Math.max(lastSeenFieldMs ?? 0, lastLogMs ?? 0) || null;

    const isStale =
      lastSeenMs === null ||
      now.toMillis() - lastSeenMs > OFFLINE_THRESHOLD_MS;

    if (isStale && data.offline !== true) {
      updates.offline = true;
      offlineFlagged++;
      updates.openOfflineIncidentId = await openIncident(
        doc,
        "offline",
        "อุปกรณ์ขาดการติดต่อเกิน 30 นาที"
      );
      if (data.uid) {
        await sendLineAlert(
          data.uid,
          `⚠️ อุปกรณ์ "${doc.id}" ขาดการติดต่อเกิน 30 นาที ลองตรวจสอบสัญญาณ/แหล่งจ่ายไฟด้วยครับ`,
          "offline"
        );
      }
    } else if (!isStale && data.offline === true) {
      updates.offline = false;
      updates.openOfflineIncidentId = admin.firestore.FieldValue.delete();
      onlineCleared++;
      await closeIncident(doc, data.openOfflineIncidentId);
      if (data.uid) {
        await sendLineAlert(
          data.uid,
          `✅ อุปกรณ์ "${doc.id}" กลับมาเชื่อมต่อได้ปกติแล้ว`,
          "offline"
        );
      }
    }

    // 3) ป้าย "faultType" ตัวเดียวต่ออุปกรณ์ ครอบคลุมปัญหาที่ไม่ใช่ offline
    //    ทั้งหมด มี 2 แหล่งสัญญาณที่แก้ไขค่าเดียวกันนี้ได้:
    //      (a) แนวโน้มความชื้นที่เราคำนวณเอง (เดิม, ผ่าน 30 นาที)
    //      (b) firmware รายงานตรงๆ ผ่าน Error/ErrorTime (ไวกว่ามาก — เพื่อน
    //          ยืนยันว่า ~2 นาทีสำหรับ valve, ทันทีสำหรับ sensor/nano)
    //    เก็บผลไว้ใน effectiveFaultType/effectiveOpenFaultIncidentId ตัวแปร
    //    เดียวก่อน ค่อยเขียนลง Firestore ครั้งเดียวตอนท้าย กันสองแหล่งสัญญาณ
    //    เปิด/ปิด incident ทับกันเองในรอบเดียวกัน
    let effectiveFaultType = data.faultType || null;
    let effectiveOpenFaultIncidentId = data.openFaultIncidentId || null;

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
      // ขาดการติดต่ออยู่แล้ว ไม่ต้องซ้ำเรื่องอื่น เคลียร์ป้ายทิ้งไปก่อน (ปิด
      // incident เงียบๆ ไม่ถือว่า "หายแล้ว" จริง เลยไม่ส่ง LINE)
      if (effectiveFaultType) {
        faultsCleared++;
        await closeIncident(doc, effectiveOpenFaultIncidentId);
        effectiveFaultType = null;
        effectiveOpenFaultIncidentId = null;
      }
    } else {
      // 3a) firmware รายงาน error ตรงๆ ผ่าน Error/ErrorTime — เพื่อนยืนยันว่า
      //     "พอกลับมาทำงานปกติมันไม่เคลียร์ให้" คือ field นี้ค้างค่าเดิมไว้
      //     ตลอดไปเองในฝั่ง firmware ดังนั้นห้ามใช้การที่ Error หายไปเป็น
      //     สัญญาณว่า "หายแล้ว" — ใช้ ErrorTime แค่จับ "มี error ใหม่เกิดขึ้น"
      //     (ค่าขยับจากที่เช็ครอบก่อน) ส่วนการปิด incident ให้ไปดูที่ (3c)
      const errorText = data.Error || null;
      const errorTimeMs = data.ErrorTime?.toMillis?.() ?? null;
      const lastCheckedErrorTimeMs =
        data._lastCheckedErrorTime?.toMillis?.() ?? null;
      const isNewFirmwareError =
        errorText !== null &&
        errorTimeMs !== null &&
        errorTimeMs !== lastCheckedErrorTimeMs;

      if (isNewFirmwareError) {
        const mapped = FIRMWARE_ERROR_TYPES[errorText];

        if (!mapped) {
          // ข้อความ error ที่ยังไม่รู้จัก (เช่น "WiFi Disconnected" ที่ตาม
          // ที่เพื่อนยืนยัน ไม่มีทางส่งมาถึง Firestore ได้จริงอยู่แล้ว) —
          // จำไว้ว่าเช็คแล้ว ไม่ต้อง retry ทุกรอบ แต่ไม่เปิด incident ให้
          updates._lastCheckedErrorTime = data.ErrorTime;
        } else if (effectiveFaultType === null) {
          // ช่องว่าง เปิด incident ใหม่จากสัญญาณของ firmware ได้เลย
          updates._lastCheckedErrorTime = data.ErrorTime;
          faultsFlagged++;
          effectiveOpenFaultIncidentId = await openIncident(
            doc,
            mapped.type,
            mapped.label
          );
          effectiveFaultType = mapped.type;
          if (data.uid) {
            await sendLineAlert(
              data.uid,
              `🚱 อุปกรณ์ "${doc.id}" ${mapped.label}`,
              "fault"
            );
          }
        }
        // ถ้า mapped แต่ช่องไม่ว่าง (มี fault อื่นเปิดค้างอยู่แล้ว) จะไม่มาร์ค
        // ว่าเช็คแล้ว รอรอบหน้าให้ช่องว่างก่อนค่อยเปิดให้
      }

      // 3b) แนวโน้มความชื้นที่เราคำนวณเอง (เดิม) — ให้ทำงานเฉพาะตอนช่องว่าง
      //     หรือช่องนั้นเป็นปัญหาวาล์วอยู่แล้ว กันไม่ให้ไปทับ sensor/nano
      //     error ที่ firmware เพิ่งรายงานเข้ามาในรอบเดียวกัน
      if (
        canJudgeValve &&
        (effectiveFaultType === null ||
          effectiveFaultType === "valve_stuck_open" ||
          effectiveFaultType === "valve_no_flow")
      ) {
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

          let trendFaultType = null;
          if (!valveIsOpen && delta > MOISTURE_NOISE_FLOOR_PERCENT) {
            trendFaultType = "valve_stuck_open";
          } else if (valveIsOpen && delta < MOISTURE_NOISE_FLOOR_PERCENT) {
            trendFaultType = "valve_no_flow";
          }

          if (effectiveFaultType !== trendFaultType) {
            if (trendFaultType) {
              faultsFlagged++;
              const label =
                trendFaultType === "valve_stuck_open"
                  ? "วาล์วค้างเปิด (น้ำอาจไหลไม่หยุด)"
                  : "วาล์วอาจไม่ทำงาน (เปิดน้ำแล้วความชื้นไม่ขึ้น)";
              effectiveOpenFaultIncidentId = await openIncident(
                doc,
                trendFaultType,
                label
              );
              effectiveFaultType = trendFaultType;
              if (data.uid) {
                await sendLineAlert(
                  data.uid,
                  `🚱 อุปกรณ์ "${doc.id}" ${label} ลองตรวจสอบวาล์ว/ท่อน้ำด้วยครับ`,
                  "fault"
                );
              }
            } else {
              faultsCleared++;
              await closeIncident(doc, effectiveOpenFaultIncidentId);
              effectiveFaultType = null;
              effectiveOpenFaultIncidentId = null;
              if (data.uid) {
                await sendLineAlert(
                  data.uid,
                  `✅ อุปกรณ์ "${doc.id}" วาล์วกลับมาทำงานปกติแล้ว`,
                  "fault"
                );
              }
            }
          }
        }
      }

      // 3c) ปิด incident ที่มาจาก firmware error (sensor_error/nano_error)
      //     เอง เมื่อพบว่าอุปกรณ์รายงานค่าใหม่สำเร็จหลังจากเวลาที่ error เกิด
      //     (lastSeen ใหม่กว่า ErrorTime) — ต้องทำเองเพราะ Error/ErrorTime
      //     ฝั่ง firmware ไม่เคลียร์ค่าให้เอง (ยืนยันจากเพื่อนแล้ว)
      if (
        (effectiveFaultType === "sensor_error" ||
          effectiveFaultType === "nano_error") &&
        effectiveOpenFaultIncidentId &&
        lastSeenMs !== null &&
        data.ErrorTime?.toMillis?.() != null &&
        lastSeenMs > data.ErrorTime.toMillis()
      ) {
        faultsCleared++;
        await closeIncident(doc, effectiveOpenFaultIncidentId);
        effectiveFaultType = null;
        effectiveOpenFaultIncidentId = null;
        if (data.uid) {
          await sendLineAlert(
            data.uid,
            `✅ อุปกรณ์ "${doc.id}" กลับมาทำงานปกติแล้ว`,
            "fault"
          );
        }
      }
    }

    if (effectiveFaultType !== (data.faultType || null)) {
      updates.faultType = effectiveFaultType
        ? effectiveFaultType
        : admin.firestore.FieldValue.delete();
    }
    if (effectiveOpenFaultIncidentId !== (data.openFaultIncidentId || null)) {
      updates.openFaultIncidentId = effectiveOpenFaultIncidentId
        ? effectiveOpenFaultIncidentId
        : admin.firestore.FieldValue.delete();
    }

    if (Object.keys(updates).length > 0) {
      await doc.ref.update(updates);
    }
  }

  const summary = {
    scanned: snapshot.size,
    assigned,
    offlineFlagged,
    onlineCleared,
    faultsFlagged,
    faultsCleared,
  };

  console.log("✅ checkDevices:", summary);

  return summary;
}
