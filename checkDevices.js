import admin from "firebase-admin";
import fetch from "node-fetch";

// ไม่เรียก admin.initializeApp() ในไฟล์นี้ — ฟังก์ชันนี้ถูก import เข้าไปใช้
// ใน index.js ซึ่ง initialize แอปไว้แล้วตั้งแต่ตอนเริ่มเซิร์ฟเวอร์

// ส่งข้อความแจ้งเตือนไปหาเจ้าของอุปกรณ์ผ่าน LINE Messaging API — ใช้
// lineUserId ที่เก็บไว้ตอน login แล้ว (users/{uid}.lineUserId) ไม่ต้องสร้าง
// ระบบ map ผู้ใช้ใหม่ ถ้ายังไม่ได้ตั้ง LINE_MESSAGING_TOKEN หรือหา
// lineUserId ไม่เจอ จะข้ามไปเงียบๆ ไม่ทำให้ checkDevices ทั้งรอบพัง
async function sendLineAlert(uid, text) {
  if (!process.env.LINE_MESSAGING_TOKEN) {
    return;
  }

  try {
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    const lineUserId = userDoc.exists ? userDoc.data().lineUserId : null;

    if (!lineUserId) {
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

// ฟังก์ชันนี้แทนที่ Cloud Functions ทั้ง 4 ตัวที่เขียนไว้ก่อนหน้า (ซึ่ง deploy
// ไม่ได้เพราะโปรเจกต์ยังอยู่ Firebase plan ฟรี) — ทำงานแบบ "โพล" เรียกผ่าน
// route /cron/check-devices ใน index.js โดยมี cron ภายนอกฟรียิงเข้ามาเป็น
// รอบๆ แทนแบบ trigger เรียลไทม์ ไม่ต้องใช้ Blaze plan เลย เพราะรันบน Render
// ด้วย Admin SDK ตรงๆ เหมือนกับ /update route เดิม
export async function checkDevices() {
  const db = admin.firestore();
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
          `⚠️ อุปกรณ์ "${doc.id}" ขาดการติดต่อเกิน 30 นาที ลองตรวจสอบสัญญาณ/แหล่งจ่ายไฟด้วยครับ`
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
          `✅ อุปกรณ์ "${doc.id}" กลับมาเชื่อมต่อได้ปกติแล้ว`
        );
      }
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
      // (ปิด incident เงียบๆ ไม่ถือว่า "หายแล้ว" จริง เลยไม่ส่ง LINE)
      if (data.faultType) {
        updates.faultType = admin.firestore.FieldValue.delete();
        updates.openFaultIncidentId = admin.firestore.FieldValue.delete();
        faultsCleared++;
        await closeIncident(doc, data.openFaultIncidentId);
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
            const label =
              faultType === "valve_stuck_open"
                ? "วาล์วค้างเปิด (น้ำอาจไหลไม่หยุด)"
                : "วาล์วอาจไม่ทำงาน (เปิดน้ำแล้วความชื้นไม่ขึ้น)";
            updates.openFaultIncidentId = await openIncident(
              doc,
              faultType,
              label
            );
            if (data.uid) {
              await sendLineAlert(
                data.uid,
                `🚱 อุปกรณ์ "${doc.id}" ${label} ลองตรวจสอบวาล์ว/ท่อน้ำด้วยครับ`
              );
            }
          } else {
            faultsCleared++;
            updates.openFaultIncidentId = admin.firestore.FieldValue.delete();
            await closeIncident(doc, data.openFaultIncidentId);
            if (data.uid) {
              await sendLineAlert(
                data.uid,
                `✅ อุปกรณ์ "${doc.id}" วาล์วกลับมาทำงานปกติแล้ว`
              );
            }
          }
        }
      }
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
