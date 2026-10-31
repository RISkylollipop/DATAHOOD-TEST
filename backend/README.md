# KwaraPolyData Backend — Quick Start (Postman Testing)

This gets the API running locally so you can test with Postman while we keep building.

## 1. Prerequisites
- **Node.js 18+** (you have 22 — good)
- **MySQL** running locally with your `kwarapo1_datahood` database imported

## 2. Install
```bash
cd backend
npm install
```
> Note: this must be run on YOUR machine. The build sandbox blocks npm, so packages
> aren't installed here — that's expected.

## 3. Configure secrets
```bash
cp .env.example .env
```
Then open `.env` and fill in:
- `DB_PASSWORD` — your MySQL password (**rotate the old one**, it was exposed in the old code)
- `JWT_SECRET` — run: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `APP_ENCRYPTION_KEY` — run: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ADMIN_ALERT_EMAIL` — where downtime + blacklist alerts should go
- SMTP settings if you want emails to actually send (optional for now)

## 4. Create the new `blacklist` table
The blacklist workflow uses a NEW table (the old `blacklisted_emails` couldn't do
approvals). Run the SQL in `sql/blacklist_table.sql` against your database once:
```bash
mysql -u kwarapo1_datahood -p kwarapo1_datahood < sql/blacklist_table.sql
```

## 5. Run
```bash
npm run dev     # auto-reload (nodemon)
# or
npm start
```
You should see: `🚀 KwaraPolyData API running on port 5000`
and `✅ Database connection established successfully.`

## 6. Test in Postman
1. Import `KwaraPolyData.postman_collection.json`
2. Check the collection variable `baseUrl` = `http://localhost:5000/api`
3. Run **Health check** first — should return `{ status: "ok" }`
4. Run **Auth → Register user** — auto-saves your token
5. Run **Blacklist → Submit** — lands as `pending`
6. For admin routes: set your admin password in the DB first (see below),
   run **Admin login**, then the approve/reject/remove requests work.

## 7. Set your admin password (one-time)
The old admin password was plaintext. To set a bcrypt one:
```bash
node -e "require('bcrypt').hash('YOUR_NEW_ADMIN_PASSWORD', 12).then(h => console.log(h))"
```
Copy the hash, then in MySQL:
```sql
UPDATE sysusers SET sysToken = 'PASTE_HASH_HERE' WHERE sysUsername = 'admin@kwarapolydata';
```
(Or just log in once with the old plaintext password — the code auto-upgrades it to bcrypt on first successful login.)

## What's testable right now
- ✅ Health check
- ✅ User register (with blacklist enforcement + bcrypt)
- ✅ User login (with legacy password auto-upgrade)
- ✅ Admin login
- ✅ Blacklist: submit → approve/reject → remove, and view queue

## Coming next
- Airtime / Data / Cable / Electricity / Exam purchase endpoints
- Wallet funding (Monnify, Paymentpoint, Palmpay)
- Provider management, push notifications, WhatsApp receipts, WebAuthn, device binding
