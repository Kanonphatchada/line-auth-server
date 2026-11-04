// ตรรกะจัดสถานะ "การติดต่อ" ของอุปกรณ์ แยกเป็นฟังก์ชันล้วนๆ (ไม่แตะ Firestore)
// เพื่อให้เทสได้ — checkDevices.js เป็นคนดึงเวลาล่าสุดและเขียนผลลง Firestore เอง
//
// 3 สถานะ:
//   active  = ส่งข้อมูลล่าสุดภายใน OFFLINE_THRESHOLD_MS            → ปกติ
//   offline = เงียบเกิน OFFLINE_THRESHOLD_MS แต่ยังไม่เกิน DORMANT   → ขาดการติดต่อ
//             (เตือนเจ้าของ เพราะน่าจะเพิ่งพัง/หลุด)
//   dormant = ไม่เคยส่งข้อมูลเลย หรือเงียบเกิน DORMANT_AFTER_MS      → ไม่ได้ใช้งาน
//             (เช่น อุปกรณ์สร้างไว้ทดสอบที่ไม่มีเครื่องจริง) ไม่ถือเป็น
//             "ขาดการติดต่อ" ไม่เตือน และไม่ขึ้น popup — ถ้ากลับมาส่งข้อมูล
//             อีกครั้งจะกลับเป็น active เอง

export const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 นาที
export const DORMANT_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 วัน

// lastSeenMs = เวลาล่าสุดที่เห็นอุปกรณ์ส่งข้อมูล (ms) หรือ null ถ้าไม่เคยเลย
export function classifyActivity(lastSeenMs, nowMs) {
  if (lastSeenMs === null || lastSeenMs === undefined) return "dormant";
  const silentMs = nowMs - lastSeenMs;
  if (silentMs > DORMANT_AFTER_MS) return "dormant";
  if (silentMs > OFFLINE_THRESHOLD_MS) return "offline";
  return "active";
}
