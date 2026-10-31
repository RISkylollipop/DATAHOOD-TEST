import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const c = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectTimeout: 15000,
});

const [col] = await c.query(
  `SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions'
      AND COLUMN_NAME IN ('servicedesc','servicename','oldbal','newbal','amount')`,
  [process.env.DB_NAME]
);
console.log('COLUMNS:', JSON.stringify(col));

const [rows] = await c.query(
  "SELECT tId, servicedesc FROM transactions WHERE servicename='Airtime' ORDER BY tId DESC LIMIT 5"
);
console.log('RECENT_AIRTIME:', JSON.stringify(rows));

await c.end();
