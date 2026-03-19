// ============================================================
// server.js — SecureVault Backend
// Express + PostgreSQL + Cloudinary
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id UUID PRIMARY KEY,
      cloudinary_url TEXT NOT NULL,
      cloudinary_public_id TEXT NOT NULL,
      passcode_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Database table ready');
}

// ════════════════════════════════════════════════════════════
// ROUTE 1: Generate Cloudinary Upload Signature
// NOTE: For signed uploads, we sign ONLY timestamp + folder.
// upload_preset is sent separately but NOT included in signature.
// ════════════════════════════════════════════════════════════
app.get('/api/sign-upload', (req, res) => {
  const timestamp = Math.round(new Date().getTime() / 1000);
  const folder = 'securevault';

  // Sign ONLY timestamp and folder — NOT upload_preset
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder },
    process.env.CLOUDINARY_API_SECRET
  );

  res.json({
    timestamp,
    signature,
    folder,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY
  });
});

// ════════════════════════════════════════════════════════════
// ROUTE 2: Save Video Metadata After Upload
// ════════════════════════════════════════════════════════════
app.post('/api/videos', async (req, res) => {
  const { cloudinary_url, cloudinary_public_id, passcode } = req.body;

  if (!cloudinary_url || !cloudinary_public_id || !passcode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (passcode.length < 4) {
    return res.status(400).json({ error: 'Passcode must be at least 4 characters' });
  }

  const passcode_hash = await bcrypt.hash(passcode, 12);
  const id = uuidv4();

  await pool.query(
    'INSERT INTO videos (id, cloudinary_url, cloudinary_public_id, passcode_hash) VALUES ($1, $2, $3, $4)',
    [id, cloudinary_url, cloudinary_public_id, passcode_hash]
  );

  res.json({ success: true, id });
});

// ════════════════════════════════════════════════════════════
// ROUTE 3: Retrieve Video
// ════════════════════════════════════════════════════════════
app.post('/api/videos/:id/retrieve', async (req, res) => {
  const { id } = req.params;
  const { passcode } = req.body;

  const result = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = result.rows[0];
  const match = await bcrypt.compare(passcode, video.passcode_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect passcode' });
  }

  res.json({ success: true, url: video.cloudinary_url });
});

// ════════════════════════════════════════════════════════════
// ROUTE 4: Delete Video
// ════════════════════════════════════════════════════════════
app.delete('/api/videos/:id', async (req, res) => {
  const { id } = req.params;
  const { passcode } = req.body;

  const result = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = result.rows[0];
  const match = await bcrypt.compare(passcode, video.passcode_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect passcode' });
  }

  await cloudinary.uploader.destroy(video.cloudinary_public_id, {
    resource_type: 'video'
  });

  await pool.query('DELETE FROM videos WHERE id = $1', [id]);
  res.json({ success: true, message: 'Video permanently deleted' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 SecureVault running on port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err);
  process.exit(1);
});
    
