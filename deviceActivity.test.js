import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyActivity,
  OFFLINE_THRESHOLD_MS,
  DORMANT_AFTER_MS,
} from "./deviceActivity.js";

const NOW = Date.UTC(2026, 9, 19, 9, 30);
const MIN = 60 * 1000;

test("ไม่เคยส่งข้อมูลเลย = dormant (ไม่ใช่ offline)", () => {
  assert.equal(classifyActivity(null, NOW), "dormant");
  assert.equal(classifyActivity(undefined, NOW), "dormant");
});

test("ส่งข้อมูลภายใน 30 นาที = active", () => {
  assert.equal(classifyActivity(NOW - 5 * MIN, NOW), "active");
  assert.equal(classifyActivity(NOW - OFFLINE_THRESHOLD_MS, NOW), "active");
});

test("เงียบเกิน 30 นาที แต่ไม่เกิน 7 วัน = offline", () => {
  assert.equal(classifyActivity(NOW - OFFLINE_THRESHOLD_MS - 1, NOW), "offline");
  assert.equal(classifyActivity(NOW - 24 * 60 * MIN, NOW), "offline");
  assert.equal(classifyActivity(NOW - DORMANT_AFTER_MS, NOW), "offline");
});

test("เงียบเกิน 7 วัน = dormant (เช่น Nano3 ที่เห็นครั้งสุดท้ายเมื่อ 17 ก.ย.)", () => {
  assert.equal(classifyActivity(NOW - DORMANT_AFTER_MS - 1, NOW), "dormant");
  assert.equal(classifyActivity(Date.UTC(2026, 8, 17, 8, 48), NOW), "dormant");
});

test("กลับมาส่งข้อมูลอีกครั้ง = active ทันที", () => {
  const longAgo = NOW - 30 * 24 * 60 * MIN;
  assert.equal(classifyActivity(longAgo, NOW), "dormant");
  assert.equal(classifyActivity(NOW - MIN, NOW), "active");
});
