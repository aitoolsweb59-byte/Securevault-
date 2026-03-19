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

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
// Serve frontend files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ── PostgreSQL Connection Pool ───────────────────────────────
// DATABASE_URL is set in Render dashboard environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Render PostgreSQL
});

// ── Cloudinary Config ────────────────────────────────────────
// These values come from your Cloudinary dashboard
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── Database Setup ───────────────────────────────────────────
// Creates the videos table if it doesn't exist yet
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
// ROUTE 1: Generate a Cloudinary Upload Signature
// ────────────────────────────────────────────────────────────
// How it works:
//   - The browser needs a signed "permission slip" from our server
//     to upload directly to Cloudinary.
//   - We generate that signature here using our secret API key.
//   - The browser then uploads the video DIRECTLY to Cloudinary,
//     completely bypassing our server.
//   - This means Render never handles the video file itself,
//     so there are NO memory or file size limits on our end.
// ════════════════════════════════════════════════════════════
app.get('/api/sign-upload', (req, res) => {
  const timestamp = Math.round(new Date().getTime() / 1000);
  const folder = 'securevault';

  // Cloudinary signs these parameters with our secret key
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
// ────────────────────────────────────────────────────────────
// After the browser uploads the video to Cloudinary, it calls
// this route to save the video URL + hashed passcode in our DB.
// ════════════════════════════════════════════════════════════
app.post('/api/videos', async (req, res) => {
  const { cloudinary_url, cloudinary_public_id, passcode } = req.body;

  // Validate inputs
  if (!cloudinary_url || !cloudinary_public_id || !passcode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (passcode.length < 4) {
    return res.status(400).json({ error: 'Passcode must be at least 4 characters' });
  }

  // Hash the passcode — we NEVER store it as plain text
  const passcode_hash = await bcrypt.hash(passcode, 12);
  const id = uuidv4(); // Generate a unique ID for this video

  await pool.query(
    'INSERT INTO videos (id, cloudinary_url, cloudinary_public_id, passcode_hash) VALUES ($1, $2, $3, $4)',
    [id, cloudinary_url, cloudinary_public_id, passcode_hash]
  );

  res.json({ success: true, id });
});

// ════════════════════════════════════════════════════════════
// ROUTE 3: Retrieve a Video by ID + Passcode
// ════════════════════════════════════════════════════════════
app.post('/api/videos/:id/retrieve', async (req, res) => {
  const { id } = req.params;
  const { passcode } = req.body;

  const result = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = result.rows[0];

  // Compare entered passcode against stored hash
  const match = await bcrypt.compare(passcode, video.passcode_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect passcode' });
  }

  res.json({ success: true, url: video.cloudinary_url });
});

// ════════════════════════════════════════════════════════════
// ROUTE 4: Delete a Video (from DB + Cloudinary)
// ════════════════════════════════════════════════════════════
app.delete('/api/videos/:id', async (req, res) => {
  const { id } = req.params;
  const { passcode } = req.body;

  const result = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = result.rows[0];

  // Verify passcode before allowing deletion
  const match = await bcrypt.compare(passcode, video.passcode_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect passcode' });
  }

  // Delete from Cloudinary cloud storage
  await cloudinary.uploader.destroy(video.cloudinary_public_id, {
    resource_type: 'video'
  });

  // Delete from our database
  await pool.query('DELETE FROM videos WHERE id = $1', [id]);

  res.json({ success: true, message: 'Video permanently deleted' });
});

// ── Catch-all: serve frontend for any unknown route ─────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ─────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 SecureVault running on port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err);
  process.exit(1);
});
