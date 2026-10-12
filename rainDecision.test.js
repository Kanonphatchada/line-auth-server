import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRainForecast,
  decideRainSkip,
  RAIN_SKIP_MAX_MS,
} from "./rainDecision.js";

const HOUR = 3600;
const MIN = 60 * 1000;
const H = 60 * MIN;

// สร้างพยากรณ์รายชั่วโมงปลอม เริ่มที่ startSec (unix วินาที)
const forecast = (startSec, probs, precs) => ({
  times: probs.map((_, i) => startSec + i * HOUR),
  probs,
  precs,
});

// 14:25 เวลาไทย = 07:25 UTC — ค่าที่บั๊กเดิมพลาด (ตีความ "14:00" เป็น UTC)
const NOW = Date.UTC(2026, 9, 9, 7, 25);
const THIS_HOUR = Date.UTC(2026, 9, 9, 7, 0) / 1000;

test("ฝนแรง 3 ชม.ข้างหน้า → บอกว่าฝนตก", () => {
  const f = forecast(THIS_HOUR, [90, 90, 90, 0], [1, 1, 1, 0]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), true);
});

test("โอกาสสูงแต่ปริมาณไม่ถึง 1 มม. → ไม่ใช่ฝน", () => {
  const f = forecast(THIS_HOUR, [80, 80, 80], [0.2, 0.2, 0.2]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), false);
});

test("ปริมาณถึงแต่โอกาสต่ำกว่า 70% → ไม่ใช่ฝน", () => {
  const f = forecast(THIS_HOUR, [60, 60, 60], [2, 2, 2]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), false);
});

test("ฝนอยู่แค่ชั่วโมงที่ผ่านไปแล้ว (เช้า) → ไม่นับ — เคสบั๊กเวลา 7 ชม.", () => {
  // ฝนตก 07:00–10:00 เวลาไทย (00:00–03:00 UTC) แต่ตอนนี้บ่ายสองแล้ว
  const early = Date.UTC(2026, 9, 9, 0, 0) / 1000;
  const f = forecast(early, [95, 95, 95, 0, 0, 0, 0, 0, 0], [3, 3, 3, 0, 0, 0, 0, 0, 0]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), false);
});

test("ฝนจะตกอีก 2 ชม.ข้างหน้า (บ่ายสี่เวลาไทย) → ต้องเจอ", () => {
  const f = forecast(THIS_HOUR, [0, 0, 90, 90, 90], [0, 0, 2, 2, 2]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), true);
});

test("ชั่วโมงปัจจุบันที่ยังไม่จบ (14:00 ตอน 14:25) ยังนับ", () => {
  const f = forecast(THIS_HOUR, [90, 0, 0, 0], [2, 0, 0, 0]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), true);
});

test("ฝนอยู่ไกลเกิน 3 ชม. → ไม่นับ", () => {
  const f = forecast(THIS_HOUR, [0, 0, 0, 95, 95], [0, 0, 0, 3, 3]);
  assert.equal(evaluateRainForecast({ ...f, nowMs: NOW }), false);
});

test("ข้อมูลว่าง/ไม่มีชั่วโมงให้เช็ค → ไม่ใช่ฝน (รดตามปกติ)", () => {
  assert.equal(
    evaluateRainForecast({ times: [], probs: [], precs: [], nowMs: NOW }),
    false
  );
});

test("ฝนเริ่มพยากรณ์ → เริ่มข้ามและจำเวลาเริ่ม", () => {
  const r = decideRainSkip({ rainForecast: true, skipStartedAtMs: null, nowMs: NOW });
  assert.deepEqual(r, { skip: true, skipStartedAtMs: NOW });
});

test("ข้ามต่อเนื่องทุกรอบ cron (10 นาที) ไม่สลับ ข้าม/ไม่ข้าม — เคสบั๊กนับรอบ", () => {
  let started = null;
  for (let i = 0; i < 18; i++) {
    const r = decideRainSkip({
      rainForecast: true,
      skipStartedAtMs: started,
      nowMs: NOW + i * 10 * MIN,
    });
    assert.equal(r.skip, true, `รอบที่ ${i} ต้องข้าม`);
    started = r.skipStartedAtMs;
  }
});

test("ครบเพดาน 3 ชม. แล้วฝนยังพยากรณ์อยู่ → กลับมารดและไม่เริ่มข้ามใหม่", () => {
  const started = NOW;
  const atCap = decideRainSkip({
    rainForecast: true,
    skipStartedAtMs: started,
    nowMs: NOW + RAIN_SKIP_MAX_MS,
  });
  assert.equal(atCap.skip, false);
  assert.equal(atCap.skipStartedAtMs, started);
  const later = decideRainSkip({
    rainForecast: true,
    skipStartedAtMs: started,
    nowMs: NOW + RAIN_SKIP_MAX_MS + 10 * MIN,
  });
  assert.equal(later.skip, false);
});

test("ฝนหมดก่อนครบเพดาน → รดทันทีและล้างเวลาเริ่ม", () => {
  const r = decideRainSkip({
    rainForecast: false,
    skipStartedAtMs: NOW,
    nowMs: NOW + 1 * H,
  });
  assert.deepEqual(r, { skip: false, skipStartedAtMs: null });
});

test("ฝนหมดแล้วมีฝนรอบใหม่ → เริ่มนับเพดานใหม่", () => {
  const cleared = decideRainSkip({
    rainForecast: false,
    skipStartedAtMs: NOW,
    nowMs: NOW + 4 * H,
  });
  const again = decideRainSkip({
    rainForecast: true,
    skipStartedAtMs: cleared.skipStartedAtMs,
    nowMs: NOW + 5 * H,
  });
  assert.deepEqual(again, { skip: true, skipStartedAtMs: NOW + 5 * H });
});

test("ตั้งเพดานเองได้ (เตรียมไว้ให้ผู้ใช้ปรับในอนาคต)", () => {
  const r = decideRainSkip({
    rainForecast: true,
    skipStartedAtMs: NOW,
    nowMs: NOW + 1.5 * H,
    maxSkipMs: 1 * H,
  });
  assert.equal(r.skip, false);
});
