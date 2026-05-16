// src/config.js (ESM)
import 'dotenv/config';

export const cfg = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DATABASE_PATH || './data.db',
  jwtSecret: process.env.JWT_SECRET || 'dev',
  mapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
  staticBaseUrl: process.env.STATIC_BASE_URL || 'http://localhost:3000',
  wppSession: process.env.WPP_SESSION || 'default',
};
