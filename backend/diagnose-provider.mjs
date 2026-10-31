#!/usr/bin/env node
// ============================================================
//  Provider Connection Diagnostic
// ------------------------------------------------------------
//  Run this ON YOUR SERVER (where outbound network works) to
//  quickly test whether your active airtime provider responds.
//  It mimics what purchaseAirtimeHandler does but stops at the
//  HTTP call so you see the exact failure before any purchase.
// ============================================================

import sequelize from './config/database.js';
import { Provider } from './models/index.js';
import { decryptSecret } from './utils/crypto.js';
import dotenv from 'dotenv';

dotenv.config();

async function diagnose() {
  console.log('\n🔍 Provider Connection Diagnostic\n');

  try {
    // 1. Connect to DB
    console.log('→ Connecting to database...');
    await sequelize.authenticate();
    console.log('✓ Database connected\n');

    // 2. Find active airtime provider (same query your purchase uses)
    console.log('→ Fetching active airtime provider...');
    const provider = await Provider.findOne({
      where: { category: 'airtime', status: 'active', isDefault: true },
    });

    if (!provider) {
      console.error('✗ No active airtime provider found in `providers` table.');
      console.log('  → Check the admin panel or run this SQL:');
      console.log('     SELECT * FROM providers WHERE category="airtime";');
      process.exit(1);
    }

    console.log(`✓ Found: ${provider.name}`);
    console.log(`  Host: ${provider.baseUrl}`);
    console.log(`  Auth: ${provider.authStyle || 'token (default)'}\n`);

    // 3. Decrypt the API key
    if (!provider.apiKey) {
      console.error('✗ Provider has no apiKey configured.');
      process.exit(1);
    }
    const apiKey = decryptSecret(provider.apiKey);
    console.log('✓ API key decrypted (length:', apiKey.length, 'chars)\n');

    // 4. Test the HTTP call (a minimal airtime request)
    console.log('→ Calling provider (test airtime request)...');
    const testBody = {
      network: '1', // MTN
      amount: '50',
      mobile_number: '08012345678',
      Ported_number: false,
      'request-id': `TEST${Date.now()}`,
      airtime_type: 'VTU',
    };

    const started = Date.now();
    const res = await fetch(provider.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${apiKey}`,
      },
      body: JSON.stringify(testBody),
    });
    const elapsed = Date.now() - started;

    console.log(`✓ HTTP ${res.status} ${res.statusText} (${elapsed}ms)`);

    const raw = await res.text();
    console.log('\nRaw response body:');
    console.log(raw.substring(0, 500)); // first 500 chars

    let parsed;
    try {
      parsed = JSON.parse(raw);
      console.log('\n✓ Valid JSON response:');
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('\n✗ Response is NOT JSON — provider may be returning HTML error page.');
    }

    console.log('\n✅ Connection test complete. The provider responded.');
    console.log('   If you see an error in the JSON (e.g. invalid key, insufficient balance),');
    console.log('   that is GOOD — it proves the endpoint is reachable and the real issue is');
    console.log('   credentials or config, not a network/DNS failure.\n');
  } catch (err) {
    console.error('\n✗ Connection test FAILED:\n');
    console.error('  Error:', err.message);
    if (err.cause) {
      console.error('  Cause:', err.cause.message || err.cause);
    }
    console.error('\n  This is the real root cause. Common failures:');
    console.error('    • ENOTFOUND / getaddrinfo → DNS cannot resolve the host');
    console.error('    • ECONNREFUSED → host exists but nothing listening on that port');
    console.error('    • ETIMEDOUT → network/firewall blocking the connection');
    console.error('    • certificate error → TLS handshake failed (bad cert or wrong host)');
    console.error('    • Invalid URL → baseUrl in DB is malformed\n');
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

diagnose();
