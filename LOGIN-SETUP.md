# ตั้งค่าระบบเข้าสู่ระบบ Cendon (Firebase `cendon-1`)

> ห้ามส่งคีย์ ไฟล์ .p8 ไฟล์ service account หรือรหัสใด ๆ ในแชต — ใส่ในคอนโซล/คำสั่งเองเท่านั้น

## สถานะ (เช็กจากระบบจริง 16 ต.ค. 2569)

| ช่องทาง | ฝั่ง Firebase | ที่ยังขาด |
|---|---|---|
| Google | เปิดแล้ว · โดเมน `cendon-beta.pages.dev` เพิ่มแล้ว ✓ | หลังบ้านต้อง deploy ตัวใหม่ (ส่วน 4) |
| อีเมล + รหัสผ่าน | เปิดแล้ว | หลังบ้านต้อง deploy ตัวใหม่ (ส่วน 4) |
| ลิงก์เข้าสู่ระบบทางอีเมล | ต้องเปิดสวิตช์ | ส่วน 1 ข้อ 3 |
| Apple | ยังไม่มีบัญชี Apple Developer — **พักไว้ก่อน** (ปุ่ม Apple ซ่อนอยู่จนกว่าจะตั้ง `AUTH_APPLE_ENABLED=1`) | ส่วน 2 |
| รหัส 6 หลักทางอีเมล | ไม่เกี่ยวกับ Firebase | ส่งผ่าน **Gmail ของทีม** ได้เลย ไม่ต้องมีโดเมน (ส่วน 5) — ระหว่างนี้แอปส่ง "ลิงก์" แทนให้อัตโนมัติ |

ลำดับที่แนะนำ: **1 → 3 → 4 → 5 → 6** (ส่วน 2 Apple ทำเมื่อมีบัญชี Apple Developer)

---

## ส่วน 1 — Firebase Console (เจ้าของโปรเจกต์ · ~5 นาที)

1. เปิด https://console.firebase.google.com → เลือกโปรเจกต์ **cendon-1**
2. เมนูซ้าย **Build → Authentication** → แท็บ **Settings** → **Authorized domains** → **Add domain** → ใส่ `cendon-beta.pages.dev` → **Add**
   (มีโดเมนจริงของแอปเมื่อไรให้เพิ่มที่นี่ด้วย)
3. แท็บ **Sign-in method** → แถว **Email/Password** → กดดินสอ → เปิดสวิตช์ที่สอง **Email link (passwordless sign-in)** → **Save**
   (สวิตช์แรก Email/Password เปิดอยู่แล้ว ห้ามปิด)
4. (แนะนำ) แท็บ **Templates** → แต่ละแบบ (Email address verification · Password reset · Email link sign-in) → กดดินสอ → **Sender name** = `Cendon` → **Template language** = Thai → Save

ผลที่ได้ทันที: ปุ่ม Google ใช้ได้ · "ส่งลิงก์เข้าอีเมลแทน" ใช้ได้

---

## ส่วน 2 — Sign in with Apple (ต้องมี Apple Developer Program · 99 USD/ปี · ~20 นาที) — พักไว้ก่อน

ที่ https://developer.apple.com/account → **Certificates, Identifiers & Profiles**

1. **Identifiers → +** → **App IDs** → **App** → Description `Cendon` · Bundle ID (Explicit) `com.cendon.app` → ติ๊ก **Sign in with Apple** → Continue → Register
2. **Identifiers → +** → **Services IDs** → Description `Cendon Web` · Identifier `com.cendon.web` → Register
   → กดเข้า `com.cendon.web` → ติ๊ก **Sign in with Apple** → **Configure**
   - Primary App ID: `com.cendon.app`
   - Domains and Subdomains: `cendon-1.firebaseapp.com`
   - Return URLs: `https://cendon-1.firebaseapp.com/__/auth/handler`
   → Next → Done → Continue → **Save**
3. **Keys → +** → Key Name `Cendon Sign in with Apple` → ติ๊ก **Sign in with Apple** → Configure → เลือก `com.cendon.app` → Save → Continue → Register
   → **Download** ไฟล์ `.p8` (โหลดได้ครั้งเดียว เก็บให้ดี) · จด **Key ID**
4. **Team ID**: หน้า Membership details (หรือมุมขวาบนของหน้า developer)
5. กลับ Firebase **cendon-1 → Authentication → Sign-in method → Add new provider → Apple** → Enable
   - Services ID: `com.cendon.web`
   - OAuth code flow configuration: **Apple team ID** · **Key ID** · **Private key** = เปิดไฟล์ .p8 แล้วคัดลอกทั้งหมด (รวมบรรทัด BEGIN/END)
   → **Save**
6. ให้อีเมลจาก Firebase ส่งถึงผู้ใช้ที่ซ่อนอีเมลกับ Apple: Apple Developer → **Services → Sign in with Apple for Email Communication → Configure** → เพิ่มอีเมล `noreply@cendon-1.firebaseapp.com`
7. เปิดปุ่ม Apple ในแอป: `wrangler.jsonc` → `"AUTH_APPLE_ENABLED": "1"` → `npx wrangler deploy`

---

## ส่วน 3 — ย้ายผู้ใช้จากโปรเจกต์เดิม `sp1p-82396` (คนที่มีสิทธิ์ทั้งสองโปรเจกต์ · ~10 นาที)

**ทำก่อนให้คนกลับมาล็อกอิน** — ไม่งั้นคนที่ล็อกอินใหม่จะได้บัญชีว่าง และข้อมูลรถ/งาน/แชตเดิมจะผูกกับรหัสบัญชีเก่า

บนคอมที่มี Node.js 18 ขึ้นไป:

```bash
npm install -g firebase-tools
firebase login
firebase auth:export cendon-users.json --format=json --project sp1p-82396
firebase auth:import cendon-users.json --project cendon-1
rm cendon-users.json        # ไฟล์นี้มีข้อมูลผู้ใช้ ลบทิ้งทันที
```

- ตรวจ: cendon-1 → Authentication → **Users** ต้องเห็นจำนวนเท่าเดิม และ **User UID ตรงกับโปรเจกต์เดิม**
- ถ้า import ฟ้องเรื่อง password hash (เฉพาะกรณีโปรเจกต์เดิมเคยมีบัญชีแบบรหัสผ่าน): sp1p-82396 → Authentication → Users → เมนู ⋮ → **Password hash parameters** → ใส่ค่าที่ได้ต่อท้ายคำสั่ง import
  `--hash-algo=SCRYPT --hash-key=… --salt-separator=… --rounds=8 --mem-cost=14`

---

## ส่วน 4 — หลังบ้าน (ปอนด์ · ~5 นาที)

```bash
cd spireone-backend
git pull origin main
npx wrangler deploy
```

บัญชีบริการของ `cendon-1` (ใช้ลบบัญชีถาวรฝั่งเซิร์ฟเวอร์ และใช้กับรหัส 6 หลักในส่วน 5):

1. Firebase cendon-1 → ⚙ **Project settings** → **Service accounts** → **Generate new private key** → ได้ไฟล์ .json
2. ```bash
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON < /path/to/cendon-1-key.json
   rm /path/to/cendon-1-key.json
   ```

ช่วงย้ายผู้ใช้ หลังบ้านรับ token ทั้ง `cendon-1` และ `sp1p-82396` (ตั้งไว้ใน `wrangler.jsonc` แล้ว)

---

## ส่วน 5 — รหัส 6 หลักทางอีเมล (ส่งจาก Gmail ของทีม · ไม่ต้องมีโดเมน · ~15 นาที)

ระหว่างที่ยังไม่ทำ แอปส่ง **ลิงก์เข้าสู่ระบบ** แทนให้อัตโนมัติ — ทำเสร็จเมื่อไร ปุ่มจะเปลี่ยนเป็น "ส่งรหัสเข้าอีเมลแทน" เอง
หลังบ้านขอสิทธิ์ **ส่งอีเมลอย่างเดียว** (`gmail.send`) อ่านกล่องจดหมายไม่ได้ · Gmail ธรรมดาส่งได้ราว 500 ฉบับ/วัน

### 5.1 เปิด Gmail API และหน้าขอสิทธิ์ (Google Cloud ของโปรเจกต์ cendon-1)
1. https://console.cloud.google.com → มุมซ้ายบนเลือกโปรเจกต์ **cendon-1**
2. **APIs & Services → Library** → ค้น `Gmail API` → **Enable**
3. **Google Auth Platform** (หรือ APIs & Services → OAuth consent screen)
   - Branding: App name `Cendon` · User support email = อีเมลทีม → Save
   - Audience: ถ้ายังเป็น **Testing** ให้กด **Publish app** (ถ้าค้าง Testing รหัสจะหยุดส่งทุก 7 วัน)
4. **Clients → Create client** (หรือ Credentials → Create credentials → OAuth client ID)
   - Application type: **Web application** · Name `Cendon mail`
   - Authorized redirect URIs: `https://developers.google.com/oauthplayground`
   - Create → จด **Client ID** และ **Client secret** (ห้ามส่งในแชต)

### 5.2 ขอ refresh token จากบัญชี Gmail ที่จะใช้ส่ง
1. เปิด https://developers.google.com/oauthplayground
2. ⚙ มุมขวาบน → ติ๊ก **Use your own OAuth credentials** → วาง Client ID / Client secret
3. ช่อง "Input your own scopes" ใส่ `https://www.googleapis.com/auth/gmail.send` → **Authorize APIs**
4. ล็อกอิน Gmail ของทีม → ถ้าขึ้น "Google hasn't verified this app" กด **Advanced → Go to Cendon (unsafe)** (เป็นแอปของเราเอง) → **Continue/Allow**
5. **Exchange authorization code for tokens** → คัดลอก **Refresh token**
6. ⚙ → ยกเลิกติ๊ก Use your own OAuth credentials (กันค้างไว้ในเบราว์เซอร์)

### 5.3 ใส่ในหลังบ้าน (ปอนด์)
```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
openssl rand -base64 48 | npx wrangler secret put AUTH_OTP_PEPPER
```
`wrangler.jsonc` ส่วน `vars` เพิ่ม `"AUTH_EMAIL_FROM": "<อีเมล Gmail ที่ใช้ส่ง ตัวเดียวกับข้อ 5.2>"` → `npx wrangler deploy`
ต้องมี `FIREBASE_SERVICE_ACCOUNT_JSON` จากส่วน 4 ด้วย

### ทางเลือก: Resend (เมื่อมีโดเมนของตัวเอง)
แทน 5.1–5.3 ได้: ยืนยันโดเมนที่ resend.com → `npx wrangler secret put RESEND_API_KEY` → `AUTH_EMAIL_FROM` = `no-reply@โดเมนของเรา`
(ถ้าตั้งทั้งสองแบบ หลังบ้านใช้ Gmail ก่อน)

---

## ส่วน 6 — หลังย้ายผู้ใช้ครบแล้ว

ลบบรรทัด `"FIREBASE_LEGACY_PROJECT_IDS": "sp1p-82396"` ใน `wrangler.jsonc` → `npx wrangler deploy` (ปิดการรับ token ของโปรเจกต์เดิม)

---

## ตรวจผลหลังทำ

- หน้าเข้าสู่ระบบ → **เข้าสู่ระบบด้วย Google** ต้องเด้งหน้าต่างเลือกบัญชี Google และกลับเข้าแอปได้
- **ส่งลิงก์เข้าอีเมลแทน** → อีเมลจาก `noreply@cendon-1.firebaseapp.com` (เช็กจดหมายขยะ) → กดลิงก์บนเครื่องเดิม → เข้าแอป
- **สร้างบัญชี** ด้วยอีเมล + รหัสผ่าน → ได้หน้าตั้งค่าครั้งแรก
- **ส่งรหัสเข้าอีเมลแทน** (หลังทำส่วน 5) → รหัส 6 หลักจาก Gmail ของทีม → กรอก → เข้าแอป
- **ใช้บัญชี Apple** (หลังทำส่วน 2)
- บอก Claude ว่า "ทำเสร็จแล้ว" — เช็กโดเมน/Apple จากภายนอกให้ได้
