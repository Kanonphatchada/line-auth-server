import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_LENGTH,
  INVITE_TTL_MS,
  MEMBER_ERRORS as E,
  MEMBER_LIMIT,
  accessForRegistry,
  deriveAccessLists,
  generateInviteCode,
  normalizeInviteCode,
  normalizePermissions,
  planInvite,
  planJoin,
  planLeave,
  planRemoveMember,
  planUpdateMember,
  sameAccessLists,
} from "./farmMembers.js";

const NOW = 1_000_000;
const farm = (over = {}) => ({ ownerUid: "owner", secret: "s", ...over });
const invite = (over = {}) => ({
  control: false,
  settings: false,
  expiresAt: NOW + 1000,
  used: false,
  ...over,
});

// ───────── รหัสเชิญ ─────────

test("รหัสเชิญ: ยาว 8 ตัว ใช้เฉพาะตัวอักษรที่ไม่สับสน และไม่ซ้ำกันเป็นส่วนใหญ่", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = generateInviteCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    seen.add(code);
  }
  assert.ok(seen.size > 190);
});

test("normalizeInviteCode: ตัดช่องว่าง/ขีด แปลงตัวใหญ่ ปฏิเสธรูปแบบผิด", () => {
  assert.equal(normalizeInviteCode(" abcd-2345 "), "ABCD2345");
  assert.equal(normalizeInviteCode("abcd 2345"), "ABCD2345");
  for (const bad of ["ABC", "ABCD234O", "ABCD2341", "", null, undefined, 12345678]) {
    assert.equal(normalizeInviteCode(bad), null, String(bad));
  }
});

// ───────── รายชื่อสิทธิ์ ─────────

test("deriveAccessLists: เจ้าของอยู่ทุกรายชื่อ สมาชิกอยู่ตามสิทธิ์ที่ได้", () => {
  const a = deriveAccessLists("o", {
    viewer: { control: false, settings: false },
    driver: { control: true, settings: false },
    admin: { control: true, settings: true },
  });
  // เจ้าของมาก่อน ที่เหลือเรียงตาม uid
  assert.deepEqual(a.memberUids, ["o", "admin", "driver", "viewer"]);
  assert.deepEqual(a.controlUids, ["o", "admin", "driver"]);
  assert.deepEqual(a.settingsUids, ["o", "admin"]);
});

test("deriveAccessLists: ไม่มีสมาชิก/ไม่มีเจ้าของ ไม่พัง และเจ้าของที่เผลออยู่ใน members ไม่ซ้ำ", () => {
  assert.deepEqual(deriveAccessLists("o", undefined), {
    memberUids: ["o"],
    controlUids: ["o"],
    settingsUids: ["o"],
  });
  assert.deepEqual(deriveAccessLists(null, {}), {
    memberUids: [],
    controlUids: [],
    settingsUids: [],
  });
  assert.deepEqual(
    deriveAccessLists("o", { o: { control: false } }).memberUids,
    ["o"]
  );
});

test("accessForRegistry: ฟาร์มเก่าที่ไม่มี members ได้รายชื่อมีแค่เจ้าของ", () => {
  assert.deepEqual(accessForRegistry({ ownerUid: "o" }).memberUids, ["o"]);
});

// ───────── เชิญ ─────────

test("เชิญ: เจ้าของสร้างได้ อายุ 24 ชม. ใช้ได้ครั้งเดียว", () => {
  const r = planInvite({
    registry: farm(),
    uid: "owner",
    control: true,
    settings: false,
    now: NOW,
  });
  assert.equal(r.invite.control, true);
  assert.equal(r.invite.settings, false);
  assert.equal(r.invite.expiresAt, NOW + INVITE_TTL_MS);
  assert.equal(r.invite.used, false);
});

test("เชิญ: ไม่ใช่เจ้าของ/สมาชิก/ไม่มีฟาร์ม ถูกปฏิเสธ; ค่าสิทธิ์ที่ไม่ใช่ true ถือเป็น false", () => {
  assert.equal(
    planInvite({ registry: farm(), uid: "other", now: NOW }).error,
    E.NOT_OWNER
  );
  assert.equal(
    planInvite({
      registry: farm({ members: { m: { control: true, settings: true } } }),
      uid: "m",
      now: NOW,
    }).error,
    E.NOT_OWNER
  );
  assert.equal(planInvite({ registry: null, uid: "o", now: NOW }).error, E.NOT_FOUND);
  const r = planInvite({
    registry: farm(),
    uid: "owner",
    control: "yes",
    settings: 1,
    now: NOW,
  });
  assert.equal(r.invite.control, false);
  assert.equal(r.invite.settings, false);
});

// ───────── เข้าร่วม ─────────

test("เข้าร่วม: ได้สิทธิ์ตามที่เจ้าของกำหนดในรหัส และรายชื่อสิทธิ์ถูกอัปเดต", () => {
  const r = planJoin({
    registry: farm(),
    invite: invite({ control: true }),
    uid: "bob",
    displayName: "Bob",
    now: NOW,
  });
  assert.deepEqual(r.registryUpdate.members.bob, {
    control: true,
    settings: false,
    name: "Bob",
    joinedAt: NOW,
  });
  assert.deepEqual(r.registryUpdate.memberUids, ["owner", "bob"]);
  assert.deepEqual(r.registryUpdate.controlUids, ["owner", "bob"]);
  assert.deepEqual(r.registryUpdate.settingsUids, ["owner"]);
});

test("เข้าร่วม: ไม่ทับสมาชิกเดิม", () => {
  const r = planJoin({
    registry: farm({ members: { amy: { control: true, settings: true } } }),
    invite: invite(),
    uid: "bob",
    now: NOW,
  });
  assert.ok(r.registryUpdate.members.amy.settings);
  assert.deepEqual(r.registryUpdate.memberUids, ["owner", "amy", "bob"]);
});

test("ลำดับรายชื่อไม่ขึ้นกับลำดับคีย์ใน members และ sameAccessLists ไม่สนลำดับ", () => {
  const a = deriveAccessLists("o", { z: { control: true }, a: { control: true } });
  const b = deriveAccessLists("o", { a: { control: true }, z: { control: true } });
  assert.deepEqual(a, b);
  assert.equal(sameAccessLists(a, b), true);
  assert.equal(
    sameAccessLists(
      { memberUids: ["o", "b", "a"], controlUids: ["o"], settingsUids: ["o"] },
      { memberUids: ["a", "o", "b"], controlUids: ["o"], settingsUids: ["o"] }
    ),
    true
  );
  assert.equal(sameAccessLists(a, { ...a, controlUids: ["o"] }), false);
  assert.equal(sameAccessLists(a, {}), false);
  assert.equal(sameAccessLists(undefined, undefined), false);
});

test("เข้าร่วม: รหัสผิด/ใช้แล้ว/หมดอายุ/ข้อมูลหมดอายุผิดรูป ถูกปฏิเสธ", () => {
  const base = { registry: farm(), uid: "bob", now: NOW };
  assert.equal(planJoin({ ...base, invite: null }).error, E.INVALID_CODE);
  assert.equal(
    planJoin({ ...base, invite: invite({ used: true }) }).error,
    E.CODE_USED
  );
  assert.equal(
    planJoin({ ...base, invite: invite({ expiresAt: NOW - 1 }) }).error,
    E.CODE_EXPIRED
  );
  assert.equal(
    planJoin({ ...base, invite: invite({ expiresAt: undefined }) }).error,
    E.CODE_EXPIRED
  );
  // ครบเวลาพอดียังใช้ได้
  assert.equal(
    planJoin({ ...base, invite: invite({ expiresAt: NOW }) }).error,
    undefined
  );
});

test("เข้าร่วม: เจ้าของเข้าฟาร์มตัวเอง/เป็นสมาชิกแล้ว/ฟาร์มหาย/สมาชิกเต็ม ถูกปฏิเสธ", () => {
  assert.equal(
    planJoin({ registry: farm(), invite: invite(), uid: "owner", now: NOW }).error,
    E.OWN_FARM
  );
  assert.equal(
    planJoin({
      registry: farm({ members: { bob: {} } }),
      invite: invite(),
      uid: "bob",
      now: NOW,
    }).error,
    E.ALREADY_MEMBER
  );
  assert.equal(
    planJoin({ registry: null, invite: invite(), uid: "bob", now: NOW }).error,
    E.NOT_FOUND
  );
  const full = {};
  for (let i = 0; i < MEMBER_LIMIT; i++) full[`u${i}`] = {};
  assert.equal(
    planJoin({
      registry: farm({ members: full }),
      invite: invite(),
      uid: "bob",
      now: NOW,
    }).error,
    E.MEMBER_LIMIT
  );
});

test("เข้าร่วม: ชื่อยาวเกินถูกตัด ชนิดผิดกลายเป็นว่าง", () => {
  const long = planJoin({
    registry: farm(),
    invite: invite(),
    uid: "bob",
    displayName: "x".repeat(200),
    now: NOW,
  });
  assert.equal(long.registryUpdate.members.bob.name.length, 60);
  const bad = planJoin({
    registry: farm(),
    invite: invite(),
    uid: "bob",
    displayName: { evil: 1 },
    now: NOW,
  });
  assert.equal(bad.registryUpdate.members.bob.name, "");
});

// ───────── ปรับสิทธิ์ / ลบ / ออก ─────────

const withBob = () =>
  farm({ members: { bob: { control: false, settings: false, name: "Bob" } } });

test("ปรับสิทธิ์: เจ้าของปรับได้ ไม่แตะชื่อ/วันที่เข้าร่วม สมาชิกปรับของตัวเองไม่ได้", () => {
  const r = planUpdateMember({
    registry: withBob(),
    uid: "owner",
    memberUid: "bob",
    control: true,
    settings: true,
  });
  assert.equal(r.registryUpdate.members.bob.control, true);
  assert.equal(r.registryUpdate.members.bob.name, "Bob");
  assert.deepEqual(r.registryUpdate.settingsUids, ["owner", "bob"]);

  assert.equal(
    planUpdateMember({
      registry: withBob(),
      uid: "bob",
      memberUid: "bob",
      control: true,
      settings: true,
    }).error,
    E.NOT_OWNER
  );
  assert.equal(
    planUpdateMember({
      registry: withBob(),
      uid: "owner",
      memberUid: "ghost",
      control: true,
    }).error,
    E.NOT_MEMBER
  );
});

test("ลบสมาชิก: เจ้าของลบได้ แล้วหลุดจากทุกรายชื่อ คนอื่นลบไม่ได้", () => {
  const registry = farm({
    members: { bob: { control: true, settings: true }, amy: { control: false } },
  });
  const r = planRemoveMember({ registry, uid: "owner", memberUid: "bob" });
  assert.equal(r.registryUpdate.members.bob, undefined);
  assert.deepEqual(r.registryUpdate.memberUids, ["owner", "amy"]);
  assert.deepEqual(r.registryUpdate.controlUids, ["owner"]);
  assert.equal(
    planRemoveMember({ registry, uid: "amy", memberUid: "bob" }).error,
    E.NOT_OWNER
  );
  assert.equal(
    planRemoveMember({ registry, uid: "owner", memberUid: "ghost" }).error,
    E.NOT_MEMBER
  );
});

test("สมาชิกออกเอง: ได้ เจ้าของออกไม่ได้ คนนอกออกไม่ได้", () => {
  const r = planLeave({ registry: withBob(), uid: "bob" });
  assert.deepEqual(r.registryUpdate.memberUids, ["owner"]);
  assert.equal(
    planLeave({ registry: withBob(), uid: "owner" }).error,
    E.OWNER_CANNOT_LEAVE
  );
  assert.equal(planLeave({ registry: withBob(), uid: "x" }).error, E.NOT_MEMBER);
  assert.equal(planLeave({ registry: null, uid: "x" }).error, E.NOT_FOUND);
});

test("ฟังก์ชันวางแผนไม่แก้ object registry ต้นฉบับ", () => {
  const registry = withBob();
  const snapshot = JSON.stringify(registry);
  planRemoveMember({ registry, uid: "owner", memberUid: "bob" });
  planUpdateMember({
    registry,
    uid: "owner",
    memberUid: "bob",
    control: true,
    settings: true,
  });
  planJoin({ registry, invite: invite(), uid: "zed", now: NOW });
  assert.equal(JSON.stringify(registry), snapshot);
});

test("3 ระดับสิทธิ์: ตั้งค่า (settings) บังคับให้ได้ควบคุม (control) ด้วยเสมอ", () => {
  assert.deepEqual(normalizePermissions({}), { control: false, settings: false });
  assert.deepEqual(normalizePermissions({ control: true }), {
    control: true,
    settings: false,
  });
  assert.deepEqual(normalizePermissions({ settings: true }), {
    control: true,
    settings: true,
  });
  assert.deepEqual(normalizePermissions({ control: "yes", settings: 1 }), {
    control: false,
    settings: false,
  });
});

test("เชิญ/ปรับสิทธิ์/เข้าร่วม ด้วย settings อย่างเดียว → ได้ control ด้วยทุกเส้นทาง", () => {
  const inv = planInvite({
    registry: farm(),
    uid: "owner",
    settings: true,
    now: NOW,
  });
  assert.equal(inv.invite.control, true);

  const joined = planJoin({
    registry: farm(),
    invite: invite({ settings: true, control: false }),
    uid: "bob",
    now: NOW,
  });
  assert.deepEqual(joined.registryUpdate.controlUids, ["owner", "bob"]);

  const upd = planUpdateMember({
    registry: withBob(),
    uid: "owner",
    memberUid: "bob",
    control: false,
    settings: true,
  });
  assert.equal(upd.registryUpdate.members.bob.control, true);
});
