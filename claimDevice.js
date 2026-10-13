import { timingSafeEqual } from "node:crypto";
import { deriveAccessLists } from "./farmMembers.js";

// ตรรกะ "เชื่อมอุปกรณ์เข้าบัญชี" (claim) แยกออกมาเป็นฟังก์ชันล้วนๆ ไม่แตะ
// Firestore เพื่อให้เทสได้ — index.js เป็นคนอ่านข้อมูล เรียกฟังก์ชันนี้ แล้วเขียน
// ผลลง Firestore ด้วย Admin SDK
//
// ที่มา: เดิมแอป (client) ทำเองทั้งหมด — อ่านรหัสลับจาก device_registry มาเทียบ
// ฝั่งแอป แล้วตั้ง uid/ownerUid เอง ทำให้รหัสลับรั่วให้ผู้ใช้ทุกคนอ่านได้ และใคร
// ก็ตั้ง uid เองได้โดยไม่ต้องใช้รหัส (ดู firestore.rules ชุดใหม่ที่ปิดสองช่องนี้)
// ตอนนี้ตรวจรหัสลับที่ฝั่งเซิร์ฟเวอร์ รหัสลับไม่ออกจากเซิร์ฟเวอร์อีกเลย

export const CLAIM_ERRORS = {
  NOT_FOUND: { status: 404, message: "ไม่เจออุปกรณ์" },
  WRONG_SECRET: { status: 403, message: "รหัสผ่านไม่ถูกต้อง" },
  ALREADY_OWNED: { status: 409, message: "อุปกรณ์ถูกใช้แล้ว" },
};

// เทียบรหัสลับแบบเวลาคงที่ กันการเดาจากเวลาตอบสนอง (ต่างความยาวก็ไม่ตรงทันที
// เพราะ timingSafeEqual ต้องการ buffer ความยาวเท่ากัน)
export function secretsMatch(expected, given) {
  if (typeof expected !== "string" || typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// registry = ข้อมูล device_registry/{deviceId} (null ถ้าไม่มี)
// nanoDocs = [{ id, data }] อุปกรณ์ทั้งหมดที่ groupId == deviceId
// คืน { error } หรือ { registryUpdate, nanoUpdates: [{ id, update }], skipped }
export function planClaim({ registry, nanoDocs, uid, secret }) {
  if (!registry) return { error: CLAIM_ERRORS.NOT_FOUND };
  if (!secretsMatch(registry.secret, secret)) {
    return { error: CLAIM_ERRORS.WRONG_SECRET };
  }

  const owner = registry.ownerUid ?? null;
  // เจ้าของเดิมคือตัวเองก็ผ่านได้ (ซื้อเซนเซอร์เพิ่มเข้าฟาร์มเดิม) บล็อกเฉพาะ
  // ตอนเป็นของคนอื่นจริงๆ
  if (owner !== null && owner !== uid) {
    return { error: CLAIM_ERRORS.ALREADY_OWNED };
  }

  // รายชื่อสิทธิ์ของฟาร์ม (เจ้าของ + สมาชิกที่เชิญไว้แล้ว) — อุปกรณ์ที่เพิ่งผูก
  // ต้องได้รายชื่อนี้ด้วย ไม่งั้นสมาชิกเดิมของฟาร์มจะมองไม่เห็นอุปกรณ์ตัวใหม่
  const access = deriveAccessLists(owner ?? uid, registry.members);

  const nanoUpdates = [];
  const skipped = [];
  for (const { id, data } of nanoDocs) {
    const current = data.uid ?? null;
    if (current === uid) continue; // ผูกอยู่แล้ว ไม่ต้องเขียนซ้ำ
    if (current !== null) {
      // เป็นของคนอื่นอยู่ — ไม่แย่งมา (ปล่อยให้เจ้าของเดิมยกเลิกการผูกเอง)
      skipped.push(id);
      continue;
    }
    // เติมเฉพาะฟิลด์ที่ "ยังไม่มี" กันทับค่าจริงจากฮาร์ดแวร์ (เหมือนที่แอปเคยทำ)
    const update = { uid, ...access };
    if (!("Moisture" in data)) update.Moisture = 0;
    if (!("Automois" in data)) update.Automois = 20;
    if (!("Valve" in data)) update.Valve = false;
    nanoUpdates.push({ id, update });
  }

  return {
    // เขียนรายชื่อสิทธิ์ลงฟาร์มทุกครั้ง (เติมให้ฟาร์มที่มีก่อนมีระบบสมาชิกด้วย)
    registryUpdate: owner === null ? { ownerUid: uid, ...access } : access,
    nanoUpdates,
    skipped,
  };
}

// จำกัดจำนวนครั้งที่ลองรหัสผิดต่อผู้ใช้ (กันเดารหัสลับ) — ในหน่วยความจำ จึง
// รีเซ็ตเมื่อเซิร์ฟเวอร์รีสตาร์ท พอสำหรับกันการเดาแบบรัวๆ ของผู้ใช้คนเดียว
export function createAttemptLimiter({ max = 8, windowMs = 10 * 60 * 1000 } = {}) {
  const failures = new Map(); // uid -> [timestamps]
  const recent = (uid, now) =>
    (failures.get(uid) ?? []).filter((t) => now - t < windowMs);
  return {
    isBlocked(uid, now = Date.now()) {
      return recent(uid, now).length >= max;
    },
    recordFailure(uid, now = Date.now()) {
      failures.set(uid, [...recent(uid, now), now]);
    },
    reset(uid) {
      failures.delete(uid);
    },
  };
}
