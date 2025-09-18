// backend/index.js
// const { fetch, Headers, Request, Response, FormData, Blob } = require('undici');

// // Polyfill globals expected by SDK
// if (typeof globalThis.fetch !== 'function') globalThis.fetch = fetch;
// if (typeof globalThis.Headers === 'undefined') globalThis.Headers = Headers;
// if (typeof globalThis.Request === 'undefined') globalThis.Request = Request;
// if (typeof globalThis.Response === 'undefined') globalThis.Response = Response;
// if (typeof globalThis.FormData === 'undefined') globalThis.FormData = FormData;
// if (typeof globalThis.Blob === 'undefined') globalThis.Blob = Blob;

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const FileType = require('file-type'); 
const mime = require('mime-types'); 
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");

dotenv.config();

const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const STANDARDS_DB = path.join(__dirname, "standards.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// simple persistent store for filename -> fileUri
function readStandards() {
  try {
    if (!fs.existsSync(STANDARDS_DB)) return {};
    return JSON.parse(fs.readFileSync(STANDARDS_DB, "utf8") || "{}");
  } catch {
    return {};
  }
}
function writeStandards(obj) {
  fs.writeFileSync(STANDARDS_DB, JSON.stringify(obj, null, 2), "utf8");
}

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// Google GenAI client
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});
const genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Upload helper
/**
 * Robust upload using @google/genai SDK.
 * Places the size under config.file.sizeBytes (server expects file.size_bytes).
 */
async function uploadFileToGemini(localFilePath, originalName) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set in .env');
  }

  // determine mime and size
  const mimeType = mime.lookup(originalName) || 'application/octet-stream';
  let sizeBytes;
  try {
    const stat = fs.statSync(localFilePath);
    sizeBytes = stat.size;
  } catch (e) {
    console.warn('[upload] could not stat file:', e.message);
  }
  console.log('[upload] derived mimeType=', mimeType, 'sizeBytes=', sizeBytes);

  const fileStream = fs.createReadStream(localFilePath);
  const fileBuffer = fs.readFileSync(localFilePath);

  // IMPORTANT: put size under config.file.sizeBytes (server wants file.size_bytes)
  const config = {
    displayName: originalName,
    size: sizeBytes,
    mimeType: mimeType,
  };

  try {
    console.log('[upload] calling ai.files.upload with config.file keys:', Object.keys(config));
    const uploaded = await ai.files.upload({
      file: fileStream,
      config
    });

    console.log('[upload] uploaded object:', JSON.stringify(uploaded, null, 2));

    // extract URI
    const fileUri = uploaded?.file?.uri || uploaded?.uri || uploaded?.name || uploaded?.resourceName || null;
    if (!fileUri) {
      console.warn('[upload] no fileUri found in response; full response logged above');
      throw new Error('Upload succeeded but no fileUri found in SDK response');
    }

    return { fileUri, uploaded };
  } catch (err) {
    // log detailed error payload if present
    console.error('[upload] Gemini upload failed:', err?.response?.data || err?.message || err);
    // Optional: fallback to direct multipart upload (uncomment if you want)
    // return await directMultipartUpload(localFilePath, originalName);
    throw err;
  }
}


// POST /upload
app.post("/upload", upload.single("standardFile"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const localPath = req.file.path;
    const originalName = req.file.originalname;

    const { fileUri, uploaded } = await uploadFileToGemini(localPath, originalName);

    if (!fileUri) return res.status(500).json({ error: "Gemini did not return fileUri", uploaded });

    const map = readStandards();
    map[originalName] = { fileUri, uploadedAt: new Date().toISOString() };
    writeStandards(map);

    fs.unlinkSync(localPath); // cleanup

    res.json({ filename: originalName, fileUri });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

// GET /standards
app.get("/standards", (req, res) => {
  const map = readStandards();
  const simplified = {};
  for (const [name, val] of Object.entries(map)) {
    simplified[name] = val.fileUri || val;
  }
  res.json(simplified);
});

// POST /summarize
app.post("/summarize", async (req, res) => {
  try {
    const { selectedStandards = [], prompt = "Summarize the documents." } = req.body;
    if (!Array.isArray(selectedStandards) || selectedStandards.length === 0) {
      return res.status(400).json({ error: "selectedStandards must be a non-empty array" });
    }

    const map = readStandards();
    const fileUris = selectedStandards.map(name => map[name]?.fileUri).filter(Boolean);
    if (fileUris.length === 0) return res.status(400).json({ error: "No fileUris found" });

    const parts = [
      ...fileUris.map(uri => ({ file_data: { file_uri: uri } })),
      { text: prompt }
    ];

    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }]
    });

    const summary = resp?.text
      || resp?.candidates?.[0]?.content?.parts?.[0]?.text
      || JSON.stringify(resp);

    res.json({ summary });
  } catch (err) {
    console.error("Summarize error:", err);
    res.status(500).json({ error: "Summarization failed", details: String(err) });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
