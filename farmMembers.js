import { randomInt } from "node:crypto";

// ระบบสมาชิกของฟาร์ม (หลายคนใช้ฟาร์มเดียวกัน เจ้าของตั้งสิทธิ์รายคนได้)
// ตรรกะตัดสินใจแยกเป็นฟังก์ชันล้วนๆ (ไม่แตะ Firestore) เพื่อให้เทสได้ครบทุกเคส —
// farmMembersRoutes.js เป็นคนอ่าน/เขียน Firestore ด้วย Admin SDK
//
// โมเดลข้อมูล:
//   device_registry/{farmId}.members = { [uid]: { control, settings, name, joinedAt } }
//   สิทธิ์ "ดู" มีเสมอสำหรับทุกคนที่อยู่ในฟาร์ม ส่วนสิทธิ์อื่นเจ้าของตั้งรายคน:
//     control  = สั่งวาล์ว / เปิด-ปิด Auto / ตั้งความชื้นเป้าหมาย (Automois)
//     settings = ตั้งตารางเวลา / ข้ามฝน / ตำแหน่งฟาร์ม
//   เจ้าของ (ownerUid) ได้ทุกสิทธิ์เสมอ และเป็นคนเดียวที่เชิญ/ลบสมาชิกได้
//   เพื่อให้ Firestore rules เช็คสิทธิ์ได้โดยไม่ต้องอ่านเอกสารอื่น (และให้แอปค้น
//   "อุปกรณ์ของฉัน" ได้) เก็บรายชื่อ uid แบบ denormalize ไว้ทั้งบนฟาร์มและบน
//   ESP32 ทุกตัวในฟาร์ม: memberUids / controlUids / settingsUids (derive จาก
//   ownerUid + members ด้วย deriveAccessLists ทุกครั้ง จึงไม่มีทางไม่ตรงกัน)

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // รหัสเชิญอายุ 24 ชั่วโมง
export const MEMBER_LIMIT = 20;
// ตัดตัวอักษรที่สับสนง่าย (I, O, 0, 1) เพราะผู้ใช้ต้องพิมพ์รหัสเอง
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

export const MEMBER_ERRORS = {
  NOT_FOUND: { status: 404, message: "ไม่เจอฟาร์มนี้" },
  NOT_OWNER: { status: 403, message: "เฉพาะเจ้าของฟาร์มเท่านั้น" },
  NOT_MEMBER: { status: 404, message: "ไม่ใช่สมาชิกของฟาร์มนี้" },
  INVALID_CODE: { status: 404, message: "รหัสเชิญไม่ถูกต้อง" },
  CODE_USED: { status: 409, message: "รหัสเชิญนี้ถูกใช้ไปแล้ว" },
  CODE_EXPIRED: { status: 410, message: "รหัสเชิญหมดอายุแล้ว" },
  OWN_FARM: { status: 400, message: "คุณเป็นเจ้าของฟาร์มนี้อยู่แล้ว" },
  ALREADY_MEMBER: { status: 409, message: "คุณเป็นสมาชิกของฟาร์มนี้อยู่แล้ว" },
  MEMBER_LIMIT: { status: 409, message: "ฟาร์มนี้มีสมาชิกเต็มแล้ว" },
  OWNER_CANNOT_LEAVE: {
    status: 400,
    message: "เจ้าของออกจากฟาร์มตัวเองไม่ได้ (ใช้ยกเลิกการผูกอุปกรณ์แทน)",
  },
  BAD_REQUEST: { status: 400, message: "ข้อมูลไม่ครบหรือไม่ถูกต้อง" },
};

export function generateInviteCode(rand = randomInt) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  }
  return code;
}

// ผู้ใช้พิมพ์เองอาจใส่ช่องว่าง/ตัวพิมพ์เล็ก — ปรับให้ตรงรูปแบบก่อนค้นหา
export function normalizeInviteCode(input) {
  if (typeof input !== "string") return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

// รายชื่อ uid ตามสิทธิ์ — เจ้าของอยู่ในทุกรายชื่อ ไม่ซ้ำ ไม่เรียงตามลำดับสุ่ม
export function deriveAccessLists(ownerUid, members) {
  const memberUids = [];
  const controlUids = [];
  const settingsUids = [];
  if (ownerUid) {
    memberUids.push(ownerUid);
    controlUids.push(ownerUid);
    settingsUids.push(ownerUid);
  }
  // เรียงตาม uid เพื่อให้ได้ลำดับเดิมเสมอ (Firestore ไม่รับประกันลำดับคีย์ของ
  // map) — ไม่งั้นการเทียบ "รายชื่อเปลี่ยนไหม" จะเห็นว่าเปลี่ยนทั้งที่ไม่ได้เปลี่ยน
  const entries = Object.entries(members ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  for (const [uid, m] of entries) {
    if (uid === ownerUid) continue;
    memberUids.push(uid);
    if (m?.control === true) controlUids.push(uid);
    if (m?.settings === true) settingsUids.push(uid);
  }
  return { memberUids, controlUids, settingsUids };
}

// เทียบรายชื่อสิทธิ์ว่าตรงกันไหม (ไม่สนลำดับ) — ใช้ตัดสินว่าต้องเขียนซ้ำหรือไม่
export function sameAccessLists(a, b) {
  for (const key of ["memberUids", "controlUids", "settingsUids"]) {
    const x = Array.isArray(a?.[key]) ? [...a[key]].sort() : null;
    const y = Array.isArray(b?.[key]) ? [...b[key]].sort() : null;
    if (x === null || y === null || x.join("|") !== y.join("|")) return false;
  }
  return true;
}

const ownerOf = (registry) => registry?.ownerUid ?? null;
const membersOf = (registry) => ({ ...(registry?.members ?? {}) });

function withAccess(registry, members) {
  return { members, ...deriveAccessLists(ownerOf(registry), members) };
}

// เจ้าของสร้างรหัสเชิญ (ใช้ได้ครั้งเดียว) พร้อมกำหนดสิทธิ์ที่ผู้เข้าร่วมจะได้
export function planInvite({ registry, uid, control, settings, now }) {
  if (!registry) return { error: MEMBER_ERRORS.NOT_FOUND };
  if (ownerOf(registry) !== uid) return { error: MEMBER_ERRORS.NOT_OWNER };
  return {
    invite: {
      control: control === true,
      settings: settings === true,
      createdBy: uid,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
      used: false,
    },
  };
}

// ผู้ใช้กรอกรหัสเพื่อเข้าร่วมฟาร์ม
export function planJoin({ registry, invite, uid, displayName, now }) {
  if (!invite) return { error: MEMBER_ERRORS.INVALID_CODE };
  if (invite.used === true) return { error: MEMBER_ERRORS.CODE_USED };
  if (typeof invite.expiresAt !== "number" || now > invite.expiresAt) {
    return { error: MEMBER_ERRORS.CODE_EXPIRED };
  }
  if (!registry) return { error: MEMBER_ERRORS.NOT_FOUND };
  if (ownerOf(registry) === uid) return { error: MEMBER_ERRORS.OWN_FARM };
  const members = membersOf(registry);
  if (members[uid]) return { error: MEMBER_ERRORS.ALREADY_MEMBER };
  if (Object.keys(members).length >= MEMBER_LIMIT) {
    return { error: MEMBER_ERRORS.MEMBER_LIMIT };
  }
  members[uid] = {
    control: invite.control === true,
    settings: invite.settings === true,
    name: typeof displayName === "string" ? displayName.slice(0, 60) : "",
    joinedAt: now,
  };
  return { registryUpdate: withAccess(registry, members) };
}

// เจ้าของเปลี่ยนสิทธิ์สมาชิกรายคน
export function planUpdateMember({ registry, uid, memberUid, control, settings }) {
  if (!registry) return { error: MEMBER_ERRORS.NOT_FOUND };
  if (ownerOf(registry) !== uid) return { error: MEMBER_ERRORS.NOT_OWNER };
  const members = membersOf(registry);
  if (typeof memberUid !== "string" || !members[memberUid]) {
    return { error: MEMBER_ERRORS.NOT_MEMBER };
  }
  members[memberUid] = {
    ...members[memberUid],
    control: control === true,
    settings: settings === true,
  };
  return { registryUpdate: withAccess(registry, members) };
}

// เจ้าของลบสมาชิก
export function planRemoveMember({ registry, uid, memberUid }) {
  if (!registry) return { error: MEMBER_ERRORS.NOT_FOUND };
  if (ownerOf(registry) !== uid) return { error: MEMBER_ERRORS.NOT_OWNER };
  const members = membersOf(registry);
  if (typeof memberUid !== "string" || !members[memberUid]) {
    return { error: MEMBER_ERRORS.NOT_MEMBER };
  }
  delete members[memberUid];
  return { registryUpdate: withAccess(registry, members) };
}

// สมาชิกออกจากฟาร์มเอง
export function planLeave({ registry, uid }) {
  if (!registry) return { error: MEMBER_ERRORS.NOT_FOUND };
  if (ownerOf(registry) === uid) {
    return { error: MEMBER_ERRORS.OWNER_CANNOT_LEAVE };
  }
  const members = membersOf(registry);
  if (!members[uid]) return { error: MEMBER_ERRORS.NOT_MEMBER };
  delete members[uid];
  return { registryUpdate: withAccess(registry, members) };
}

// ใช้เติมรายชื่อสิทธิ์ให้ฟาร์มที่มีอยู่ก่อนมีระบบสมาชิก (ไม่มีฟิลด์ members)
// และใช้ตอนผูกอุปกรณ์ใหม่/อุปกรณ์ใหม่ในฟาร์มที่ถูกเชิญแล้ว
export function accessForRegistry(registry) {
  return deriveAccessLists(ownerOf(registry), registry?.members);
}
