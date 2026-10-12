import test from "node:test";
import assert from "node:assert/strict";
import {
  planClaim,
  secretsMatch,
  createAttemptLimiter,
  CLAIM_ERRORS,
} from "./claimDevice.js";

const registry = (over = {}) => ({ secret: "s3cret", ownerUid: null, ...over });
const nano = (id, data = {}) => ({ id, data: { groupId: "FarmA", ...data } });

test("ไม่มีเอกสารฟาร์ม → ไม่เจออุปกรณ์", () => {
  const r = planClaim({ registry: null, nanoDocs: [], uid: "u", secret: "x" });
  assert.equal(r.error, CLAIM_ERRORS.NOT_FOUND);
});

test("รหัสลับผิด/ว่าง/ไม่ใช่ข้อความ → ปฏิเสธ", () => {
  for (const secret of ["wrong", "", undefined, null, 123]) {
    const r = planClaim({
      registry: registry(),
      nanoDocs: [],
      uid: "u",
      secret,
    });
    assert.equal(r.error, CLAIM_ERRORS.WRONG_SECRET);
  }
});

test("ฟาร์มที่ไม่มีรหัสลับในระบบ → ไม่มีรหัสไหนผ่านได้ (ไม่ใช่ undefined เทียบกันแล้วผ่าน)", () => {
  const r = planClaim({
    registry: { ownerUid: null },
    nanoDocs: [],
    uid: "u",
    secret: undefined,
  });
  assert.equal(r.error, CLAIM_ERRORS.WRONG_SECRET);
});

test("เป็นของคนอื่นอยู่แล้ว → ถูกใช้แล้ว (แต่รหัสต้องถูกก่อนถึงจะรู้)", () => {
  const owned = registry({ ownerUid: "other" });
  assert.equal(
    planClaim({ registry: owned, nanoDocs: [], uid: "u", secret: "bad" }).error,
    CLAIM_ERRORS.WRONG_SECRET
  );
  assert.equal(
    planClaim({ registry: owned, nanoDocs: [], uid: "u", secret: "s3cret" })
      .error,
    CLAIM_ERRORS.ALREADY_OWNED
  );
});

test("ฟาร์มว่าง → ผูก ownerUid และ uid ให้ทุกอุปกรณ์ที่ยังไม่มีเจ้าของ", () => {
  const r = planClaim({
    registry: registry(),
    nanoDocs: [nano("Nano1"), nano("Nano2")],
    uid: "u",
    secret: "s3cret",
  });
  assert.deepEqual(r.registryUpdate, { ownerUid: "u" });
  assert.deepEqual(
    r.nanoUpdates.map((n) => n.id),
    ["Nano1", "Nano2"]
  );
  assert.equal(r.nanoUpdates[0].update.uid, "u");
  assert.deepEqual(r.skipped, []);
});

test("เติมค่าเริ่มต้นเฉพาะฟิลด์ที่ยังไม่มี ไม่ทับค่าจริงจากฮาร์ดแวร์", () => {
  const r = planClaim({
    registry: registry(),
    nanoDocs: [
      nano("Fresh"),
      nano("Live", { Moisture: 42, Automois: 30, Valve: true }),
    ],
    uid: "u",
    secret: "s3cret",
  });
  const fresh = r.nanoUpdates.find((n) => n.id === "Fresh").update;
  assert.deepEqual(fresh, { uid: "u", Moisture: 0, Automois: 20, Valve: false });
  const live = r.nanoUpdates.find((n) => n.id === "Live").update;
  assert.deepEqual(live, { uid: "u" });
});

test("เจ้าของเดิมเพิ่มเซนเซอร์เข้าฟาร์มตัวเอง → ผ่าน เขียนเฉพาะตัวใหม่ ไม่แตะ registry", () => {
  const r = planClaim({
    registry: registry({ ownerUid: "u" }),
    nanoDocs: [nano("Nano1", { uid: "u" }), nano("Nano4")],
    uid: "u",
    secret: "s3cret",
  });
  assert.equal(r.registryUpdate, null);
  assert.deepEqual(
    r.nanoUpdates.map((n) => n.id),
    ["Nano4"]
  );
});

test("อุปกรณ์ที่เป็นของคนอื่นค้างอยู่ในฟาร์มนี้ → ไม่แย่งมา บันทึกว่าข้าม", () => {
  const r = planClaim({
    registry: registry(),
    nanoDocs: [nano("Mine"), nano("Theirs", { uid: "other" })],
    uid: "u",
    secret: "s3cret",
  });
  assert.deepEqual(r.skipped, ["Theirs"]);
  assert.deepEqual(
    r.nanoUpdates.map((n) => n.id),
    ["Mine"]
  );
});

test("uid เป็น null ในเอกสารอุปกรณ์ ถือว่ายังไม่มีเจ้าของ", () => {
  const r = planClaim({
    registry: registry(),
    nanoDocs: [nano("N", { uid: null })],
    uid: "u",
    secret: "s3cret",
  });
  assert.equal(r.nanoUpdates.length, 1);
});

test("secretsMatch: ความยาวต่าง/ชนิดผิด ไม่ผ่านและไม่ throw", () => {
  assert.equal(secretsMatch("abc", "abcd"), false);
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch(undefined, undefined), false);
});

test("ตัวจำกัดการลอง: ผิดครบกำหนดแล้วถูกบล็อก ผ่านช่วงเวลาแล้วปลด รีเซ็ตได้", () => {
  const lim = createAttemptLimiter({ max: 3, windowMs: 1000 });
  assert.equal(lim.isBlocked("u", 0), false);
  lim.recordFailure("u", 0);
  lim.recordFailure("u", 100);
  assert.equal(lim.isBlocked("u", 200), false);
  lim.recordFailure("u", 200);
  assert.equal(lim.isBlocked("u", 300), true);
  assert.equal(lim.isBlocked("other", 300), false);
  assert.equal(lim.isBlocked("u", 5000), false); // พ้นหน้าต่างเวลา
  lim.recordFailure("u", 5000);
  lim.reset("u");
  assert.equal(lim.isBlocked("u", 5001), false);
});
