import {
  MEMBER_ERRORS,
  generateInviteCode,
  normalizeInviteCode,
  planInvite,
  planJoin,
  planLeave,
  planRemoveMember,
  planUpdateMember,
  sameAccessLists,
} from "./farmMembers.js";
import { createAttemptLimiter } from "./claimDevice.js";

// เส้นทางระบบสมาชิกของฟาร์ม — ทุกเส้นทางยืนยันตัวตนด้วย Firebase ID token แล้ว
// เขียน Firestore ด้วย Admin SDK (client เขียนฟิลด์สมาชิกเองไม่ได้ตาม rules)
// ตรรกะตัดสินใจอยู่ใน farmMembers.js (มีเทสต์) ไฟล์นี้แค่อ่าน/เขียนข้อมูล

class PlanError extends Error {
  constructor(error) {
    super(error.message);
    this.planError = error;
  }
}

export function registerFarmMemberRoutes({ app, admin }) {
  const db = () => admin.firestore();
  const joinLimiter = createAttemptLimiter({ max: 10 });

  async function authenticate(req, res) {
    const header = req.headers.authorization || "";
    const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!idToken) {
      res.status(401).send("Unauthorized");
      return null;
    }
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      return { uid: decoded.uid, name: decoded.name ?? null };
    } catch (err) {
      res.status(401).send("Unauthorized");
      return null;
    }
  }

  const fail = (res, error) => res.status(error.status).send(error.message);

  const validFarmId = (v) =>
    typeof v === "string" && v.length > 0 && v.length < 200 && !v.includes("/");

  // รายชื่อสิทธิ์ใน ESP32 ทุกตัวของฟาร์มต้องตรงกับที่ฟาร์ม — เขียนเฉพาะตัวที่ต่าง
  // (batch ละไม่เกิน 400) ถ้าเขียนไม่ครบ (เช่นเน็ตหลุดกลางทาง) รอบเช็คอุปกรณ์ทุก
  // 10 นาทีใน checkDevices.js จะซิงก์ส่วนที่ขาดให้เองอยู่แล้ว
  async function syncDevices(farmId, access) {
    const snap = await db().collection("ESP32").where("groupId", "==", farmId).get();
    const stale = snap.docs.filter((d) => !sameAccessLists(d.data(), access));
    for (let i = 0; i < stale.length; i += 400) {
      const batch = db().batch();
      for (const d of stale.slice(i, i + 400)) {
        batch.update(d.ref, {
          memberUids: access.memberUids,
          controlUids: access.controlUids,
          settingsUids: access.settingsUids,
        });
      }
      await batch.commit();
    }
    return stale.length;
  }

  // อ่านฟาร์ม → วางแผน → เขียน ในธุรกรรมเดียว กันเจ้าของแก้พร้อมกันสองที่แล้ว
  // ทับกัน; extra ให้เขียนเอกสารอื่นในธุรกรรมเดียวกันได้ (เช่นทำเครื่องหมายว่า
  // รหัสเชิญถูกใช้แล้ว)
  async function mutateRegistry(farmId, makePlan, extra) {
    const ref = db().collection("device_registry").doc(farmId);
    return db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const registry = snap.exists ? snap.data() : null;
      const plan = await makePlan(registry, tx);
      if (plan.error) throw new PlanError(plan.error);
      tx.update(ref, plan.registryUpdate);
      if (extra) extra(tx);
      return plan;
    });
  }

  async function run(res, work) {
    try {
      await work();
    } catch (err) {
      if (err instanceof PlanError) return fail(res, err.planError);
      console.error("❌ farm members error:", err);
      res.status(500).send("Error");
    }
  }

  // เจ้าของสร้างรหัสเชิญ (ใช้ได้ครั้งเดียว อายุ 24 ชม.) พร้อมกำหนดสิทธิ์
  app.post("/farm/invite", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    const { farmId, control, settings } = req.body ?? {};
    if (!validFarmId(farmId)) return fail(res, MEMBER_ERRORS.BAD_REQUEST);

    await run(res, async () => {
      const snap = await db().collection("device_registry").doc(farmId).get();
      const plan = planInvite({
        registry: snap.exists ? snap.data() : null,
        uid: user.uid,
        control,
        settings,
        now: Date.now(),
      });
      if (plan.error) return fail(res, plan.error);

      // create() ล้มถ้ามีรหัสนี้อยู่แล้ว (ชนกันได้แต่น้อยมาก) → สุ่มใหม่
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateInviteCode();
        try {
          await db()
            .collection("farm_invites")
            .doc(code)
            .create({ farmId, ...plan.invite });
          return res.json({ ok: true, code, expiresAt: plan.invite.expiresAt });
        } catch (err) {
          if (err?.code !== 6 && !/ALREADY_EXISTS/.test(String(err))) throw err;
        }
      }
      throw new Error("could not generate a unique invite code");
    });
  });

  // ผู้ใช้กรอกรหัสเชิญเพื่อเข้าร่วมฟาร์ม
  app.post("/farm/join", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    if (joinLimiter.isBlocked(user.uid)) {
      return res.status(429).send("ลองรหัสผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่");
    }
    const code = normalizeInviteCode(req.body?.code);
    if (!code) {
      joinLimiter.recordFailure(user.uid);
      return fail(res, MEMBER_ERRORS.INVALID_CODE);
    }

    await run(res, async () => {
      const inviteRef = db().collection("farm_invites").doc(code);
      const now = Date.now();
      let displayName = user.name;
      if (!displayName) {
        const u = await db().collection("users").doc(user.uid).get();
        displayName = u.exists ? (u.data().displayName ?? "") : "";
      }

      // อ่านรหัสก่อนเพื่อรู้ว่าเป็นฟาร์มไหน (ธุรกรรมต้องรู้เอกสารที่จะอ่านล่วงหน้า)
      const inviteSnap = await inviteRef.get();
      if (!inviteSnap.exists) {
        joinLimiter.recordFailure(user.uid);
        return fail(res, MEMBER_ERRORS.INVALID_CODE);
      }
      const farmId = inviteSnap.data().farmId;

      let plan;
      try {
        plan = await mutateRegistry(
          farmId,
          async (registry, tx) => {
            // อ่านรหัสซ้ำในธุรกรรม — ถ้าสองคนกรอกพร้อมกัน มีคนเดียวที่ผ่าน
            const fresh = await tx.get(inviteRef);
            return planJoin({
              registry,
              invite: fresh.exists ? fresh.data() : null,
              uid: user.uid,
              displayName,
              now,
            });
          },
          (tx) =>
            tx.update(inviteRef, { used: true, usedBy: user.uid, usedAt: now })
        );
      } catch (err) {
        if (
          err instanceof PlanError &&
          err.planError === MEMBER_ERRORS.INVALID_CODE
        ) {
          joinLimiter.recordFailure(user.uid);
        }
        throw err;
      }

      joinLimiter.reset(user.uid);
      await syncDevices(farmId, plan.registryUpdate);
      const me = plan.registryUpdate.members[user.uid];
      res.json({
        ok: true,
        farmId,
        control: me.control,
        settings: me.settings,
      });
    });
  });

  // เจ้าของปรับสิทธิ์สมาชิกรายคน
  app.post("/farm/members/update", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    const { farmId, memberUid, control, settings } = req.body ?? {};
    if (!validFarmId(farmId)) return fail(res, MEMBER_ERRORS.BAD_REQUEST);
    await run(res, async () => {
      const plan = await mutateRegistry(farmId, (registry) =>
        planUpdateMember({
          registry,
          uid: user.uid,
          memberUid,
          control,
          settings,
        })
      );
      await syncDevices(farmId, plan.registryUpdate);
      res.json({ ok: true });
    });
  });

  // เจ้าของลบสมาชิก
  app.post("/farm/members/remove", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    const { farmId, memberUid } = req.body ?? {};
    if (!validFarmId(farmId)) return fail(res, MEMBER_ERRORS.BAD_REQUEST);
    await run(res, async () => {
      const plan = await mutateRegistry(farmId, (registry) =>
        planRemoveMember({ registry, uid: user.uid, memberUid })
      );
      await syncDevices(farmId, plan.registryUpdate);
      res.json({ ok: true });
    });
  });

  // สมาชิกออกจากฟาร์มเอง
  app.post("/farm/leave", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    const { farmId } = req.body ?? {};
    if (!validFarmId(farmId)) return fail(res, MEMBER_ERRORS.BAD_REQUEST);
    await run(res, async () => {
      const plan = await mutateRegistry(farmId, (registry) =>
        planLeave({ registry, uid: user.uid })
      );
      await syncDevices(farmId, plan.registryUpdate);
      res.json({ ok: true });
    });
  });
}
