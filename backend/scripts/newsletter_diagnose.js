// ============================================================
//  scripts/newsletter_diagnose.js — why is the newsletter failing?
// ------------------------------------------------------------
//  "The newsletter is failing" has at least six unrelated causes, and
//  from the browser they all look the same — a red toast, or a signup
//  box that spins and then says something vague. This reproduces the
//  controller's own preconditions against the live DB and the live
//  environment, and names the one that is actually broken.
//
//  The causes it separates:
//
//   1. TABLES MISSING. newsletter_tables.sql was never applied. This is
//      the most common one by far, because the newsletter shipped after
//      the last time anyone ran the migrator. Everything 503s with
//      MIGRATION_PENDING, which the public form shows as "briefly
//      unavailable" — wording that sounds transient and is not.
//   2. COLLATION UNSUPPORTED. The DDL asks for utf8mb4_0900_ai_ci,
//      which exists only on MySQL 8. On MariaDB or MySQL 5.7 the
//      CREATE TABLE fails outright, so cause 1 is the symptom and this
//      is the reason — worth distinguishing, because re-running the
//      migrator will not fix it.
//   3. MAIL NOT CONFIGURED. RESEND_API_KEY unset or MAIL_FROM on an
//      unverified domain. Signup then APPEARS to succeed: the row is
//      written, the confirmation mail throws, and mailConfirmation()
//      deliberately swallows it so a mail outage cannot leak which
//      addresses exist. Nobody can ever confirm, so the list stays at
//      zero confirmed and the admin composer has nobody to send to.
//   4. LINKS POINT NOWHERE. CLIENT_ORIGINS unset, so confirm and
//      unsubscribe URLs are built against the fallback origin. The mail
//      arrives and the link 404s.
//   5. NOTHING TO SEND TO. Tables fine, mail fine, but zero confirmed
//      rows — the composer's "send" legitimately has no audience.
//   6. STUCK CAMPAIGN. A send crashed mid-flight and left status
//      'sending', which makes the admin screen look frozen.
//
//  Reuses config/database.js so it shares the app's credentials — "works
//  for the API but not for the script" cannot happen. Prints no
//  credentials, no API keys and no subscriber addresses: the output is
//  meant to be safe to paste into a chat.
//
//  Usage:  node scripts/newsletter_diagnose.js
// ============================================================

import sequelize from '../config/database.js';
import NewsletterSubscriber from '../models/NewsletterSubscriber.js';
import NewsletterCampaign from '../models/NewsletterCampaign.js';

function line() {
  process.stdout.write('-'.repeat(60) + '\n');
}

/** Does a table physically exist in the connected schema? */
async function tableExists(name) {
  const [rows] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables '
    + 'WHERE table_schema = DATABASE() AND table_name = ?',
    { replacements: [name] },
  );
  return Number(rows[0]?.n || 0) > 0;
}

const problems = [];
const warnings = [];

async function main() {
  await sequelize.authenticate();
  process.stdout.write('\nNewsletter diagnostic\n');
  line();

  // ---- 1 & 2: schema ----
  const [subsTable, campTable] = await Promise.all([
    tableExists('newsletter_subscribers'),
    tableExists('newsletter_campaigns'),
  ]);

  process.stdout.write(`newsletter_subscribers table : ${subsTable ? 'present' : 'MISSING'}\n`);
  process.stdout.write(`newsletter_campaigns   table : ${campTable ? 'present' : 'MISSING'}\n`);

  const [verRows] = await sequelize.query('SELECT VERSION() AS v');
  const version = String(verRows[0]?.v || 'unknown');
  process.stdout.write(`database server              : ${version}\n`);

  // The DDL's collation only exists on MySQL 8+. Ask the server rather
  // than parsing the version string — forks number themselves freely.
  const [collRows] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM information_schema.collations "
    + "WHERE collation_name = 'utf8mb4_0900_ai_ci'",
  );
  const collationOk = Number(collRows[0]?.n || 0) > 0;
  process.stdout.write(`utf8mb4_0900_ai_ci supported : ${collationOk ? 'yes' : 'NO'}\n`);

  if (!subsTable || !campTable) {
    if (!collationOk) {
      problems.push(
        'The newsletter tables do not exist AND this server cannot use the\n'
        + "    collation the DDL asks for (utf8mb4_0900_ai_ci is MySQL 8 only;\n"
        + `    this server is ${version}). Re-running the migrator will fail again.\n`
        + '    Fix: in backend/sql/newsletter_tables.sql replace both occurrences of\n'
        + '      COLLATE=utf8mb4_0900_ai_ci  ->  COLLATE=utf8mb4_unicode_ci\n'
        + '    then run: node scripts/migrate.js newsletter_tables.sql',
      );
    } else {
      problems.push(
        'The newsletter tables do not exist. The migration was never applied.\n'
        + '    Fix: node scripts/migrate.js\n'
        + '    then restart the backend so the pool sees the new schema.',
      );
    }
    // Everything below reads those tables, so stop here rather than
    // printing a wall of misleading zeroes.
    return;
  }

  if (!collationOk) {
    warnings.push(
      `This server (${version}) does not support utf8mb4_0900_ai_ci. The tables\n`
      + '    exist, so this is not today\'s problem — but any FUTURE .sql file using\n'
      + '    that collation will fail to apply. Most sql/ files use it.',
    );
  }

  // ---- 5: is there an audience? ----
  const [confirmed, pending, unsubscribed] = await Promise.all([
    NewsletterSubscriber.count({ where: { status: 'confirmed' } }),
    NewsletterSubscriber.count({ where: { status: 'pending' } }),
    NewsletterSubscriber.count({ where: { status: 'unsubscribed' } }),
  ]);

  line();
  process.stdout.write(`subscribers confirmed        : ${confirmed}\n`);
  process.stdout.write(`subscribers pending          : ${pending}\n`);
  process.stdout.write(`subscribers unsubscribed     : ${unsubscribed}\n`);

  if (confirmed === 0 && pending > 0) {
    problems.push(
      `${pending} address(es) signed up but NONE has ever confirmed. That pattern\n`
      + '    means the confirmation email is not arriving — signup writes the row\n'
      + '    first and the send failure is swallowed on purpose, so the form still\n'
      + '    says "check your inbox". Check the mail settings below, then look for\n'
      + '    "Newsletter confirmation email failed" in the backend log.',
    );
  }
  if (confirmed === 0 && pending === 0 && unsubscribed === 0) {
    warnings.push('The list is completely empty — nothing has been submitted yet.');
  }

  // ---- 3 & 4: environment ----
  const hasKey = Boolean(process.env.RESEND_API_KEY);
  const mailFrom = process.env.MAIL_FROM || '(unset — falls back to support@mail.kwarapolydata.com.ng)';
  const origins = String(process.env.CLIENT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  line();
  // Presence only. The key itself must never reach stdout.
  process.stdout.write(`RESEND_API_KEY               : ${hasKey ? 'set' : 'NOT SET'}\n`);
  process.stdout.write(`MAIL_FROM                    : ${mailFrom}\n`);
  process.stdout.write(`CLIENT_ORIGINS[0]            : ${origins[0] || '(unset — links use the fallback origin)'}\n`);

  if (!hasKey) {
    problems.push(
      'RESEND_API_KEY is not set, so no email can be sent at all. Confirmation\n'
      + '    links and campaigns both fail silently. Set it in backend/.env.',
    );
  }
  if (!origins.length) {
    problems.push(
      'CLIENT_ORIGINS is not set, so confirm/unsubscribe links are built against\n'
      + '    the hard-coded fallback origin. If that is not where the site actually\n'
      + '    runs, every link in every newsletter 404s. Set it in backend/.env.',
    );
  }

  // ---- 6: stuck campaigns ----
  const stuck = await NewsletterCampaign.findAll({
    where: { status: 'sending' },
    order: [['id', 'DESC']],
    limit: 5,
  });
  const totalCampaigns = await NewsletterCampaign.count();

  line();
  process.stdout.write(`campaigns sent (all time)    : ${totalCampaigns}\n`);
  process.stdout.write(`campaigns stuck 'sending'    : ${stuck.length}\n`);

  for (const c of stuck) {
    process.stdout.write(
      `  #${c.id} started ${c.startedAt} — ${c.sentCount}/${c.recipientCount} sent, ${c.failedCount} failed\n`,
    );
  }
  if (stuck.length) {
    warnings.push(
      "A campaign is still marked 'sending'. If it started a long time ago the\n"
      + '    backend was almost certainly restarted mid-send; the count shown is\n'
      + '    how far it actually got. Resending mails those people twice.',
    );
  }
}

main()
  .then(() => {
    line();
    if (!problems.length && !warnings.length) {
      process.stdout.write('\nNo problems found. Newsletter should be working.\n');
      process.stdout.write('If the UI still errors, capture the exact toast text and the\n');
      process.stdout.write('matching line from the backend log — the cause is past this script.\n\n');
    }
    if (problems.length) {
      process.stdout.write(`\nPROBLEM${problems.length > 1 ? 'S' : ''} FOUND (${problems.length}):\n\n`);
      problems.forEach((p, i) => process.stdout.write(`  ${i + 1}. ${p}\n\n`));
    }
    if (warnings.length) {
      process.stdout.write(`Worth knowing (${warnings.length}):\n\n`);
      warnings.forEach((w, i) => process.stdout.write(`  ${i + 1}. ${w}\n\n`));
    }
    return sequelize.close();
  })
  .then(() => process.exit(problems.length ? 1 : 0))
  .catch(async (err) => {
    process.stdout.write(`\nDiagnostic could not run: ${err.message}\n`);
    process.stdout.write('If this is a connection error, the backend cannot reach the database\n');
    process.stdout.write('either — that is the problem to fix first.\n\n');
    await sequelize.close().catch(() => {});
    process.exit(1);
  });
