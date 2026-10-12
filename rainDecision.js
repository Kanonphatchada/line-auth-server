// ตรรกะตัดสินใจ "ข้ามรดน้ำเพราะฝน" แยกออกมาเป็นฟังก์ชันล้วนๆ (ไม่แตะ Firestore/
// เครือข่าย) เพื่อให้เทสด้วยพยากรณ์ปลอมได้ — checkDevices.js เป็นคนดึงข้อมูล
// และเขียนผลลง Firestore เอง

export const RAIN_PROBABILITY_THRESHOLD = 70; // %
export const RAIN_PRECIP_MM_THRESHOLD = 1; // mm รวมในช่วงที่เช็ค
export const RAIN_LOOKAHEAD_HOURS = 3;
export const RAIN_SKIP_MAX_MS = 3 * 60 * 60 * 1000; // ข้ามต่อเนื่องได้นานสุด 3 ชม.

// times เป็น unix timestamp (วินาที, UTC) จาก Open-Meteo ที่ขอด้วย
// timeformat=unixtime — ไม่ต้องแปลงเขตเวลาเอง เทียบกับ Date.now() ได้ตรงๆ
// (เดิมใช้เวลาท้องถิ่นแบบไม่มี offset แล้ว new Date() บนเซิร์ฟเวอร์ UTC ทำให้
// ช่วงที่เช็คเพี้ยนไป 7 ชม.)
export function evaluateRainForecast({ times, probs, precs, nowMs }) {
  let maxProb = 0;
  let totalPrecip = 0;
  let hoursChecked = 0;
  for (
    let i = 0;
    i < times.length && hoursChecked < RAIN_LOOKAHEAD_HOURS;
    i++
  ) {
    const tMs = Number(times[i]) * 1000;
    // ชั่วโมงที่คาบเกี่ยวตอนนี้ (เช่น 14:00 ตอน 14:25) ยังนับ ไม่งั้นช่วงที่
    // เช็คจะหายไปชั่วโมงแรกทุกครั้ง
    if (tMs + 60 * 60 * 1000 <= nowMs) continue;
    maxProb = Math.max(maxProb, probs[i] ?? 0);
    totalPrecip += precs[i] ?? 0;
    hoursChecked++;
  }
  return (
    hoursChecked > 0 &&
    maxProb >= RAIN_PROBABILITY_THRESHOLD &&
    totalPrecip >= RAIN_PRECIP_MM_THRESHOLD
  );
}

// ฝนพยากรณ์ตกอยู่ → ข้ามรดน้ำต่อเนื่อง แต่ไม่เกิน maxSkipMs นับจากตอนเริ่มข้าม
// (กันพยากรณ์ผิดแล้วต้นไม้ขาดน้ำนาน) พอครบแล้วรดตามปกติจนกว่าพยากรณ์จะบอกว่า
// ฝนหมด ถึงจะเริ่มนับใหม่ได้ ฝนหมดเมื่อไหร่ก็กลับมารดทันที ไม่ต้องรอครบเพดาน
// skipStartedAtMs = เวลาที่เริ่มข้ามของ "ช่วงฝนนี้" (null ถ้ายังไม่ได้เริ่ม)
// คืน { skip, skipStartedAtMs } — ถ้า skipStartedAtMs ต่างจากที่ส่งเข้ามา
// ผู้เรียกต้องบันทึกค่าใหม่ลง Firestore
export function decideRainSkip({
  rainForecast,
  skipStartedAtMs,
  nowMs,
  maxSkipMs = RAIN_SKIP_MAX_MS,
}) {
  if (!rainForecast) {
    return { skip: false, skipStartedAtMs: null };
  }
  if (skipStartedAtMs == null) {
    return { skip: true, skipStartedAtMs: nowMs };
  }
  return {
    skip: nowMs - skipStartedAtMs < maxSkipMs,
    skipStartedAtMs,
  };
}
