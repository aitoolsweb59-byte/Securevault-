// ============================================================
// app.js — SecureVault Frontend Logic
// Handles: webcam recording, file upload, Cloudinary direct
//          upload via signed URL, retrieve, delete.
// ============================================================

// ── State ────────────────────────────────────────────────────
let mediaRecorder = null;     // MediaRecorder instance
let recordedChunks = [];      // Video chunks from webcam
let recordedBlob = null;      // Final recorded video blob
let selectedFile = null;      // User-selected file
let currentSource = 'file';   // 'webcam' | 'file'
let webcamStream = null;      // Live webcam stream

// ── Tab Switching ─────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('panel-upload').style.display   = tab === 'upload'   ? 'flex' : 'none';
  document.getElementById('panel-retrieve').style.display = tab === 'retrieve' ? 'flex' : 'none';
  document.getElementById('tab-upload').classList.toggle('active',   tab === 'upload');
  document.getElementById('tab-retrieve').classList.toggle('active', tab === 'retrieve');
}

// ── Source Toggle (webcam vs file) ───────────────────────────
function setSource(src) {
  currentSource = src;

  const webcamSec = document.getElementById('webcam-section');
  const fileSec   = document.getElementById('file-section');

  if (src === 'webcam') {
    webcamSec.style.cssText = 'display:flex!important;flex-direction:column;gap:12px;';
    fileSec.style.display   = 'none';
    startWebcamPreview();
  } else {
    webcamSec.style.cssText = 'display:none!important;';
    fileSec.style.display   = 'flex';
    stopWebcam();
  }

  // Visual feedback on buttons
  document.getElementById('src-webcam').style.borderColor = src === 'webcam' ? 'var(--accent)' : '';
  document.getElementById('src-webcam').style.color       = src === 'webcam' ? 'var(--accent)' : '';
  document.getElementById('src-file').style.borderColor   = src === 'file'   ? 'var(--accent)' : '';
  document.getElementById('src-file').style.color         = src === 'file'   ? 'var(--accent)' : '';
}

// ── Webcam Preview ────────────────────────────────────────────
async function startWebcamPreview() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('webcam-preview').srcObject = webcamStream;
  } catch (err) {
    showAlert('upload', 'error', '⚠️ Camera access denied. Please allow camera permissions.');
  }
}

function stopWebcam() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
}

// ── Webcam Recording ─────────────────────────────────────────
function startRecording() {
  if (!webcamStream) return;

  recordedChunks = [];
  recordedBlob   = null;

  // Choose a supported codec
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(webcamStream, { mimeType });

  // Collect video data chunks as they arrive
  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  // When recording stops, assemble the final blob
  mediaRecorder.onstop = () => {
    recordedBlob = new Blob(recordedChunks, { type: mimeType });

    // Show preview of recorded video
    const previewWrap  = document.getElementById('recorded-preview-wrap');
    const previewVideo = document.getElementById('recorded-preview');
    previewVideo.src   = URL.createObjectURL(recordedBlob);
    previewWrap.style.display = 'block';

    // Re-enable stop button appearance
    document.getElementById('btn-stop-rec').disabled     = true;
    document.getElementById('btn-stop-rec').style.opacity = '0.4';
    document.getElementById('btn-start-rec').textContent  = '● Re-record';
    document.getElementById('rec-status').style.cssText   = 'display:none!important;';
  };

  mediaRecorder.start(250); // Collect data every 250ms

  // UI state
  document.getElementById('btn-start-rec').disabled     = true;
  document.getElementById('btn-start-rec').style.opacity = '0.4';
  document.getElementById('btn-stop-rec').disabled       = false;
  document.getElementById('btn-stop-rec').style.opacity  = '1';
  document.getElementById('rec-status').style.cssText    = 'display:flex!important;align-items:center;gap:8px;';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  document.getElementById('btn-start-rec').disabled = false;
  document.getElementById('btn-start-rec').style.opacity = '1';
}

// ── File Selected ─────────────────────────────────────────────
function onFileSelected() {
  const fileInput = document.getElementById('video-file');
  selectedFile = fileInput.files[0] || null;
}

// ════════════════════════════════════════════════════════════
// MAIN UPLOAD FLOW
// ────────────────────────────────────────────────────────────
// Step 1: Validate inputs
// Step 2: Fetch a signed upload URL from our backend
// Step 3: Upload the video DIRECTLY to Cloudinary using XHR
//         (this bypasses our server — no file size limit!)
// Step 4: Save video metadata to our database via backend
// Step 5: Show the Video ID to the user
// ════════════════════════════════════════════════════════════
async function uploadVideo() {
  // ── Get the video blob/file ──────────────────────────────
  let videoData = null;
  if (currentSource === 'webcam') {
    if (!recordedBlob) return showAlert('upload', 'error', 'Please record a video first.');
    videoData = recordedBlob;
  } else {
    if (!selectedFile) return showAlert('upload', 'error', 'Please select a video file.');
    videoData = selectedFile;
  }

  // ── Validate passcode ────────────────────────────────────
  const passcode  = document.getElementById('upload-passcode').value.trim();
  const passcode2 = document.getElementById('upload-passcode2').value.trim();
  if (!passcode || passcode.length < 4) return showAlert('upload', 'error', 'Passcode must be at least 4 characters.');
  if (passcode !== passcode2)           return showAlert('upload', 'error', 'Passcodes do not match.');

  clearAlert('upload');
  const btn = document.getElementById('btn-upload');
  btn.disabled = true;
  btn.textContent = 'Preparing upload...';

  try {
    // ── STEP 2: Get Cloudinary signed upload params ────────
    const sigRes  = await fetch('/api/sign-upload');
    const sigData = await sigRes.json();

    // ── STEP 3: Direct upload to Cloudinary ───────────────
    // We use XMLHttpRequest (not fetch) so we can track progress
    const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${sigData.cloudName}/auto/upload`;
    const formData = new FormData();
        formData.append('file',      videoData);
    formData.append('api_key',    sigData.apiKey);
    formData.append('timestamp',  sigData.timestamp);
    formData.append('signature',  sigData.signature);
    formData.append('folder',        sigData.folder);

    showProgress(true);
    btn.textContent = 'Uploading...';

    const uploadResult = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      // Track real-time upload progress
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setProgress(pct, `Uploading to cloud... ${pct}%`);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
        else {
          // Parse Cloudinary's error message so we can show it
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error('Cloudinary: ' + (err.error?.message || xhr.responseText)));
          } catch {
            reject(new Error('Cloudinary HTTP ' + xhr.status + ': ' + xhr.responseText));
          }
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));

      xhr.open('POST', cloudinaryUrl);
      xhr.send(formData);
    });

    setProgress(100, 'Saving securely...');
    btn.textContent = 'Saving...';

    // ── STEP 4: Save metadata to our database ─────────────
    const saveRes = await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudinary_url:       uploadResult.secure_url,
        cloudinary_public_id: uploadResult.public_id,
        passcode
      })
    });
    const saveData = await saveRes.json();
    if (!saveRes.ok) throw new Error(saveData.error || 'Failed to save');

    // ── STEP 5: Show success + Video ID ───────────────────
    showProgress(false);
    document.getElementById('upload-success').style.display = 'flex';
    document.getElementById('video-id-display').textContent = saveData.id;
    showAlert('upload', 'success', '🎉 Video saved! Copy your Video ID above.');
    btn.textContent = '✓ Upload Complete';

  } catch (err) {
    showProgress(false);
    showAlert('upload', 'error', '❌ Upload failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Upload & Secure';
  }
}

// ── Copy Video ID ─────────────────────────────────────────────
function copyID() {
  const id = document.getElementById('video-id-display').textContent;
  navigator.clipboard.writeText(id).then(() => {
    document.getElementById('video-id-display').textContent = '✓ Copied!';
    setTimeout(() => {
      document.getElementById('video-id-display').textContent = id;
    }, 1500);
  });
}

// ════════════════════════════════════════════════════════════
// RETRIEVE FLOW
// ════════════════════════════════════════════════════════════
async function retrieveVideo() {
  const id       = document.getElementById('retrieve-id').value.trim();
  const passcode = document.getElementById('retrieve-passcode').value.trim();
  if (!id)       return showAlert('retrieve', 'error', 'Please enter your Video ID.');
  if (!passcode) return showAlert('retrieve', 'error', 'Please enter your passcode.');

  clearAlert('retrieve');
  document.getElementById('retrieve-result').style.display = 'none';

  try {
    const res  = await fetch(`/api/videos/${id}/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode })
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Access denied');

    // Show video player with the Cloudinary URL
    document.getElementById('retrieved-video').src = data.url;
    document.getElementById('retrieve-result').style.display = 'flex';
    showAlert('retrieve', 'success', '✓ Passcode correct. Your video is ready.');

  } catch (err) {
    showAlert('retrieve', 'error', '❌ ' + err.message);
  }
}

// ════════════════════════════════════════════════════════════
// DELETE FLOW
// ════════════════════════════════════════════════════════════
async function deleteVideo() {
  const id       = document.getElementById('retrieve-id').value.trim();
  const passcode = document.getElementById('retrieve-passcode').value.trim();
  if (!id)       return showAlert('retrieve', 'error', 'Please enter your Video ID.');
  if (!passcode) return showAlert('retrieve', 'error', 'Please enter your passcode.');

  // Confirm before destroying
  if (!confirm('⚠️ This will permanently delete your video from the cloud and database. There is NO undo. Continue?')) return;

  clearAlert('retrieve');

  try {
    const res  = await fetch(`/api/videos/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deletion failed');

    document.getElementById('retrieve-result').style.display = 'none';
    showAlert('retrieve', 'success', '🗑 Video permanently deleted.');
    document.getElementById('retrieve-id').value       = '';
    document.getElementById('retrieve-passcode').value = '';

  } catch (err) {
    showAlert('retrieve', 'error', '❌ ' + err.message);
  }
}

// ── UI Helpers ────────────────────────────────────────────────
function showAlert(panel, type, msg) {
  const el = document.getElementById(`${panel}-alert`);
  el.className = `alert alert-${type} show`;
  el.textContent = msg;
}
function clearAlert(panel) {
  const el = document.getElementById(`${panel}-alert`);
  el.className = 'alert';
  el.textContent = '';
}
function showProgress(visible) {
  document.getElementById('progress-wrap').style.display = visible ? 'flex' : 'none';
}
function setProgress(pct, label) {
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-pct').textContent  = pct + '%';
  document.getElementById('progress-label').textContent = label;
}

// ── Init ──────────────────────────────────────────────────────
setSource('file'); // default to file upload mode
      
