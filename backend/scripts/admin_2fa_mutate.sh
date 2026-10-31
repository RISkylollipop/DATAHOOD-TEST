#!/bin/bash
# Mutation harness for the admin 2FA suite.
#
# A green test suite that has never been observed to FAIL proves nothing —
# it may be asserting things that are true of any implementation. Each
# mutant below breaks one security property on purpose. The suite must
# notice. A mutant that SURVIVES is a hole in the tests, not a pass.
#
# The no-op guard matters: if sed matches nothing, the "mutant" is pristine
# code and it would be recorded as a spurious survivor. Diff first.

MUT=/tmp/mut
ORIG="/sessions/focused-charming-brahmagupta/mnt/DATAHOOD PROJECT/backend"

# Refresh the whole mutation tree from source before doing anything.
#
# This is not housekeeping — it is the difference between a real result and a
# fictional one. run_mutant copies ONLY the file it mutates, so everything
# else in $MUT is whatever was there last time. A stale tree meant the
# selftest, the middleware and the stubs were all from an earlier revision:
# mutants were scored against tests that no longer existed and code that had
# since changed, and the harness reported "killed" and "SURVIVED" with total
# confidence either way. Silent, and worse than no result at all.
#
# node_modules is symlinked rather than copied (it is large, and the Windows
# -built bcrypt binary is stubbed by the loader anyway).
rm -rf "$MUT"
mkdir -p "$MUT"
for d in config controllers middleware models routes scripts services utils; do
  cp -r "$ORIG/$d" "$MUT/$d"
done
cp "$ORIG/package.json" "$MUT/" 2>/dev/null
[ -f "$ORIG/.env" ] && cp "$ORIG/.env" "$MUT/"
mkdir -p "$MUT/logs"
ln -sfn "$ORIG/node_modules" "$MUT/node_modules"

# A mutation run is only meaningful if the UNMUTATED tree passes. If the
# baseline is already red, every "killed" below is killed by the pre-existing
# breakage and proves nothing about the mutant.
baseline=$(cd "$MUT" && timeout 120 node --experimental-loader ./scripts/test_stubs.mjs \
           scripts/admin_2fa_selftest.mjs 2>&1 | grep -E "^  [0-9]+ assertions passed")
if [ -z "$baseline" ]; then
  echo "BASELINE IS RED — the unmutated tree does not pass. Aborting; results would be noise."
  exit 1
fi
echo "baseline:$baseline"
echo

run_mutant () {
  local name="$1"; local file="$2"; local script="$3"
  cp "$ORIG/$file" "$MUT/$file"
  python3 - "$MUT/$file" "$script" <<'PY'
import sys, re
path, script = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
old = src
ns = {'src': src, 're': re}
exec(script, ns)
src = ns['src']
if src == old:
    sys.exit(42)
open(path, 'w', encoding='utf-8').write(src)
PY
  if [ $? -eq 42 ]; then
    echo "  NO-OP   $name  <-- MUTATION DID NOT APPLY, result meaningless"
    cp "$ORIG/$file" "$MUT/$file"; return
  fi

  local out
  out=$(cd "$MUT" && timeout 120 node --experimental-loader ./scripts/test_stubs.mjs \
        scripts/admin_2fa_selftest.mjs 2>&1 | grep -E "^  [0-9]+ assertions|^  failed:")
  if echo "$out" | grep -q "FAILED"; then
    echo "  killed  $name"
    echo "$out" | grep "failed:" | sed 's/^/            /'
  else
    echo "  SURVIVED  $name  <-- THE TESTS DO NOT COVER THIS"
  fi
  cp "$ORIG/$file" "$MUT/$file"
}

C=controllers/admin2faController.js
A=controllers/authController.js
W=middleware/auth.js

BATCH="${1:-all}"

if [ "$BATCH" = "1" ] || [ "$BATCH" = "all" ]; then
echo "=== challenge token ==="
run_mutant "M1  login issues a real session token instead of a challenge" "$A" \
  "src = src.replace('if (Number(admin.sysTotpEnabled) === 1) {', 'if (false) {')"

run_mutant "M2  challenge carries role admin" "$C" \
  "src = src.replace(\"const CHALLENGE_ROLE = 'admin_2fa_pending';\", \"const CHALLENGE_ROLE = 'admin';\")"

run_mutant "M3  verify also accepts a full admin token" "$C" \
  "src = src.replace(\"if (decoded.role !== CHALLENGE_ROLE) {\", \"if (decoded.role !== CHALLENGE_ROLE && decoded.role !== 'admin') {\")"

run_mutant "M4  challenge ignores credential fingerprints" "$C" \
  "src = src.replace(\"if (decoded.pwdRef !== credRef(admin.sysToken) || decoded.tfaRef !== credRef(admin.sysTotpSecret)) {\", 'if (false) {')"

echo "=== replay ==="
run_mutant "M5  accepted TOTP step is never persisted" "$C" \
  "src = src.replace('admin.sysTotpLastStep = result.step;', '/* mutant */;', 1)"

run_mutant "M6  lastStep not passed to verifyTotp on login" "$C" \
  "src = src.replace('const result = verifyTotp(secret, submitted, { lastStep: admin.sysTotpLastStep });', 'const result = verifyTotp(secret, submitted);')"
fi

if [ "$BATCH" = "2" ] || [ "$BATCH" = "all" ]; then
echo "=== enrolment ==="
run_mutant "M7  setup enables 2FA immediately (one-phase)" "$C" \
  "src = src.replace('admin.sysTotpConfirmedAt = null;', 'admin.sysTotpEnabled = 1;', 1)"

run_mutant "M8  secret stored in plaintext" "$C" \
  "src = src.replace('admin.sysTotpSecret = encryptSecret(secret);', 'admin.sysTotpSecret = secret;')"

run_mutant "M9  backup codes stored unhashed" "$C" \
  "src = src.replace('backupCodes.map((c) => hashPassword(normalizeBackupCode(c)))', 'backupCodes.map(async (c) => normalizeBackupCode(c))')"

run_mutant "M10 setup allowed while 2FA is live" "$C" \
  "src = src.replace('if (Number(admin.sysTotpEnabled) === 1) {\n      return res.status(409).json({\n        status: \'fail\',\n        msg: \'Two-factor authentication is already enabled. Disable it first to re-enrol a new device.\',\n      });\n    }', 'if (false) { return; }')"

echo "=== backup codes ==="
run_mutant "M11 backup code is not consumed (reusable)" "$C" \
  "src = src.replace('stored.splice(matchIndex, 1);', '/* mutant */;')"
fi

if [ "$BATCH" = "3" ] || [ "$BATCH" = "all" ]; then
echo "=== disable ==="
run_mutant "M12 disable skips the emailed OTP" "$C" \
  "src = src.replace('if (!otpResult.ok) {', 'if (false) {')"

run_mutant "M13 disable skips the password check" "$C" \
  "src = src.replace('if (!passwordOk) {', 'if (false) {')"

run_mutant "M14 disable leaves backup codes behind" "$C" \
  "src = src.replace('admin.sysBackupCodes = null; // codes for a removed secret must not linger', '/* mutant */;')"

run_mutant "M15 disable OTP not scoped to the sysuser actor" "$C" \
  "src = src.replace('      { actorType: ACTOR.SYSUSER }\n    );', '      { actorType: ACTOR.SUBSCRIBER }\n    );')"

echo "=== response codes ==="
run_mutant "M16 verify returns 401 on a bad code (trips frontend auto-logout)" "$C" \
  "src = src.replace(\"            msg: 'That code is not correct. Use the current code from your authenticator app, or a backup code.',\", \"            msg: 'nope',\").replace('          return res.status(422).json({\n            status: \'fail\',\n            msg: \'nope\',', '          return res.status(401).json({\n            status: \'fail\',\n            msg: \'nope\',')"

fi

if [ "$BATCH" = "4" ] || [ "$BATCH" = "all" ]; then
echo "=== token revocation ==="
# The gap these lock in: admin JWTs live 7 days and used to be irrevocable
# for the whole window, so enabling 2FA did nothing about the session the
# attacker already had.
run_mutant "M17 requireAdmin ignores the token version" "$W" \
  "src = src.replace('if ((decoded.tv ?? 0) !== (admin.sysTokenVersion || 0)) {', 'if (false) {')"

run_mutant "M18 admin token minted without a tv claim" "$A" \
  "src = src.replace(\"role: 'admin', tv: admin.sysTokenVersion || 0 })\", \"role: 'admin' })\")"

run_mutant "M19 enabling 2FA does not evict other sessions" "$C" \
  "src = src.replace('admin.sysTokenVersion = (admin.sysTokenVersion || 0) + 1;', '/* mutant */;')"

run_mutant "M20 confirm returns no replacement token (logs the admin out)" "$C" \
  "src = src.replace('data: { backupCodes, token: signAdminToken(admin), admin: adminPublic(admin) },', 'data: { backupCodes, admin: adminPublic(admin) },')"

echo "=== blocked accounts (POLARITY: 0 = active) ==="
run_mutant "M21 login does not check sysStatus" "$A" \
  "src = src.replace('if (Number(admin.sysStatus) !== 0) {', 'if (false) {')"

run_mutant "M22 requireAdmin does not check sysStatus" "$W" \
  "src = src.replace('if (Number(admin.sysStatus) !== 0) {', 'if (false) {')"

# The instinctive 'fix' that would lock out the only real admin, whose row
# ships as sysStatus 0. If this SURVIVES, nothing is defending the polarity.
run_mutant "M23 sysStatus polarity inverted to 1-means-enabled" "$A" \
  "src = src.replace('if (Number(admin.sysStatus) !== 0) {', 'if (Number(admin.sysStatus) !== 1) {')"
fi

echo
echo "restored from $ORIG"
