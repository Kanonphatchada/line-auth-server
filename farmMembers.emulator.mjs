// ทดสอบเส้นทางสมาชิกของฟาร์มกับ Firestore emulator จริง (ธุรกรรม, การเขียนรายชื่อ
// สิทธิ์ลงอุปกรณ์, การใช้รหัสเชิญพร้อมกัน) — ไม่ได้อยู่ใน `npm test` เพราะต้องมี
// emulator รันด้วย: npm run test:emulator (ไม่ต่อกับโปรเจกต์ Firebase จริง)
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import { registerFarmMemberRoutes } from "./farmMembersRoutes.js";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8091";
admin.initializeApp({ projectId: "demo-members" });
const db = admin.firestore();

// token ปลอม: "tok-<uid>" → uid นั้น (ไม่ต่อ Firebase Auth จริง)
const fakeAdmin = {
  auth: () => ({
    verifyIdToken: async (t) => {
      if (!t.startsWith("tok-")) throw new Error("bad token");
      const uid = t.slice(4);
      return { uid, name: uid.toUpperCase() };
    },
  }),
  firestore: () => db,
};

let server;
let base;

before(async () => {
  const app = express();
  app.use(bodyParser.json());
  registerFarmMemberRoutes({ app, admin: fakeAdmin });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  for (const col of ["device_registry", "ESP32", "farm_invites"]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection("device_registry").doc("FarmA").set({
    ownerUid: "owner",
    secret: "s3cret",
    // ฟาร์มเก่าก่อนมีระบบสมาชิก: ไม่มี members/รายชื่อสิทธิ์
  });
  await db.collection("device_registry").doc("FarmB").set({ ownerUid: "other" });
  for (const id of ["Nano1", "Nano2"]) {
    await db.collection("ESP32").doc(id).set({ groupId: "FarmA", uid: "owner" });
  }
  await db.collection("ESP32").doc("Nano9").set({ groupId: "FarmB", uid: "other" });
});

async function call(path, uid, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(uid ? { Authorization: `Bearer tok-${uid}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ข้อความล้วน */
  }
  return { status: res.status, json, text };
}

const registry = async (id = "FarmA") =>
  (await db.collection("device_registry").doc(id).get()).data();
const device = async (id) => (await db.collection("ESP32").doc(id).get()).data();

async function invite(permissions = {}) {
  const r = await call("/farm/invite", "owner", { farmId: "FarmA", ...permissions });
  assert.equal(r.status, 200, r.text);
  return r.json.code;
}

test("ไม่ส่ง token / token ผิด → 401 ทุกเส้นทาง", async () => {
  for (const path of [
    "/farm/invite",
    "/farm/join",
    "/farm/members/update",
    "/farm/members/remove",
    "/farm/leave",
  ]) {
    assert.equal((await call(path, null, {})).status, 401, path);
    const garbage = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-a-real-token",
      },
      body: "{}",
    });
    assert.equal(garbage.status, 401, path);
  }
});

test("เจ้าของเชิญได้ ได้รหัส 8 ตัว และเอกสารเชิญเก็บสิทธิ์/วันหมดอายุ", async () => {
  const code = await invite({ control: true, settings: false });
  assert.match(code, /^[A-Z2-9]{8}$/);
  const doc = (await db.collection("farm_invites").doc(code).get()).data();
  assert.equal(doc.farmId, "FarmA");
  assert.equal(doc.control, true);
  assert.equal(doc.settings, false);
  assert.equal(doc.used, false);
  assert.ok(doc.expiresAt > Date.now());
});

test("คนที่ไม่ใช่เจ้าของเชิญไม่ได้ (403) ฟาร์มที่ไม่มีอยู่ → 404 farmId แปลก → 400", async () => {
  assert.equal(
    (await call("/farm/invite", "bob", { farmId: "FarmA" })).status,
    403
  );
  assert.equal(
    (await call("/farm/invite", "owner", { farmId: "Nope" })).status,
    404
  );
  assert.equal(
    (await call("/farm/invite", "owner", { farmId: "a/b" })).status,
    400
  );
});

test("เข้าร่วมด้วยรหัส: เป็นสมาชิก ได้สิทธิ์ตามรหัส และอุปกรณ์ทุกตัวในฟาร์มได้รายชื่อสิทธิ์ (ไม่แตะฟาร์มอื่น)", async () => {
  const code = await invite({ control: true });
  const r = await call("/farm/join", "bob", { code });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, {
    ok: true,
    farmId: "FarmA",
    control: true,
    settings: false,
  });

  const reg = await registry();
  assert.equal(reg.members.bob.control, true);
  assert.equal(reg.members.bob.name, "BOB");
  assert.deepEqual(reg.memberUids, ["owner", "bob"]);
  assert.deepEqual(reg.controlUids, ["owner", "bob"]);
  assert.deepEqual(reg.settingsUids, ["owner"]);

  for (const id of ["Nano1", "Nano2"]) {
    const d = await device(id);
    assert.deepEqual(d.memberUids, ["owner", "bob"], id);
    assert.deepEqual(d.controlUids, ["owner", "bob"], id);
    assert.deepEqual(d.settingsUids, ["owner"], id);
    assert.equal(d.uid, "owner"); // เจ้าของไม่เปลี่ยน
  }
  assert.equal((await device("Nano9")).memberUids, undefined);
  assert.equal(
    (await db.collection("farm_invites").doc(code).get()).data().used,
    true
  );
});

test("รหัสพิมพ์ตัวเล็ก/มีขีดคั่นก็ใช้ได้", async () => {
  const code = await invite();
  const sloppy = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
  assert.equal((await call("/farm/join", "bob", { code: sloppy })).status, 200);
});

test("รหัสใช้ซ้ำ → 409, รหัสมั่ว → 404/รูปแบบผิดก็ 404, รหัสหมดอายุ → 410", async () => {
  const code = await invite();
  assert.equal((await call("/farm/join", "bob", { code })).status, 200);
  assert.equal((await call("/farm/join", "amy", { code })).status, 409);
  assert.equal((await call("/farm/join", "amy", { code: "ZZZZ2222" })).status, 404);
  assert.equal((await call("/farm/join", "amy", { code: "x" })).status, 404);

  const old = await invite();
  await db.collection("farm_invites").doc(old).update({ expiresAt: Date.now() - 1 });
  assert.equal((await call("/farm/join", "amy", { code: old })).status, 410);
  assert.equal((await registry()).members.amy, undefined);
});

test("เจ้าของเข้าฟาร์มตัวเองไม่ได้ / เป็นสมาชิกแล้วเข้าซ้ำไม่ได้ และรหัสไม่ถูกใช้ทิ้ง", async () => {
  const code = await invite();
  assert.equal((await call("/farm/join", "owner", { code })).status, 400);
  assert.equal(
    (await db.collection("farm_invites").doc(code).get()).data().used,
    false
  );
  assert.equal((await call("/farm/join", "bob", { code })).status, 200);
  const again = await invite();
  assert.equal((await call("/farm/join", "bob", { code: again })).status, 409);
});

test("สองคนกรอกรหัสเดียวกันพร้อมกัน → ผ่านได้คนเดียว (ธุรกรรม)", async () => {
  const code = await invite();
  const results = await Promise.all(
    ["bob", "amy", "cat", "dan"].map((u) => call("/farm/join", u, { code }))
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409]);
  const reg = await registry();
  assert.equal(Object.keys(reg.members).length, 1);
});

test("เจ้าของปรับสิทธิ์สมาชิก → รายชื่อบนฟาร์มและอุปกรณ์เปลี่ยนตาม สมาชิกปรับเองไม่ได้", async () => {
  await call("/farm/join", "bob", { code: await invite() }); // ดูอย่างเดียว
  assert.deepEqual((await device("Nano1")).controlUids, ["owner"]);

  const own = await call("/farm/members/update", "bob", {
    farmId: "FarmA",
    memberUid: "bob",
    control: true,
    settings: true,
  });
  assert.equal(own.status, 403);

  const r = await call("/farm/members/update", "owner", {
    farmId: "FarmA",
    memberUid: "bob",
    control: true,
    settings: false,
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await device("Nano1")).controlUids, ["owner", "bob"]);
  assert.deepEqual((await device("Nano2")).settingsUids, ["owner"]);
  assert.equal((await registry()).members.bob.name, "BOB"); // ชื่อไม่หาย

  assert.equal(
    (
      await call("/farm/members/update", "owner", {
        farmId: "FarmA",
        memberUid: "ghost",
        control: true,
      })
    ).status,
    404
  );
});

test("เจ้าของลบสมาชิก → หลุดจากรายชื่อทุกที่ คนอื่นลบไม่ได้", async () => {
  await call("/farm/join", "bob", { code: await invite({ control: true }) });
  await call("/farm/join", "amy", { code: await invite() });

  assert.equal(
    (
      await call("/farm/members/remove", "amy", {
        farmId: "FarmA",
        memberUid: "bob",
      })
    ).status,
    403
  );
  const r = await call("/farm/members/remove", "owner", {
    farmId: "FarmA",
    memberUid: "bob",
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await registry()).memberUids, ["owner", "amy"]);
  assert.deepEqual((await device("Nano1")).memberUids, ["owner", "amy"]);
  assert.deepEqual((await device("Nano1")).controlUids, ["owner"]);
});

test("สมาชิกออกเอง ได้ / เจ้าของออกไม่ได้ / คนนอกออกไม่ได้", async () => {
  await call("/farm/join", "bob", { code: await invite() });
  assert.equal((await call("/farm/leave", "owner", { farmId: "FarmA" })).status, 400);
  assert.equal((await call("/farm/leave", "zed", { farmId: "FarmA" })).status, 404);
  assert.equal((await call("/farm/leave", "bob", { farmId: "FarmA" })).status, 200);
  assert.deepEqual((await device("Nano2")).memberUids, ["owner"]);
  assert.equal((await registry()).members.bob, undefined);
});

test("ฟาร์มใหญ่: อุปกรณ์เกิน 400 ตัวซิงก์ครบ (แบ่ง batch)", async () => {
  const writes = [];
  for (let i = 0; i < 450; i++) {
    writes.push(
      db.collection("ESP32").doc(`Big${i}`).set({ groupId: "FarmA", uid: "owner" })
    );
  }
  await Promise.all(writes);
  await call("/farm/join", "bob", { code: await invite() });
  const snap = await db.collection("ESP32").where("groupId", "==", "FarmA").get();
  assert.equal(snap.size, 452);
  assert.ok(snap.docs.every((d) => d.data().memberUids?.includes("bob")));
});
