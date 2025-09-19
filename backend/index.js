// backend/index.js
// CommonJS style. If packages are ESM-only, set "type":"module" and convert imports.

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const dotenv = require("dotenv");
const { genkit, z } = require("genkit");
const { googleAI } = require("@genkit-ai/googleai");
const { GoogleAIFileManager }= require("@google/generative-ai/server");

dotenv.config();

const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const STANDARDS_DB = path.join(__dirname, "standards.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// tiny JSON store
function readStandards() {
  try {
    if (!fs.existsSync(STANDARDS_DB)) return {};
    return JSON.parse(fs.readFileSync(STANDARDS_DB, "utf8") || "{}");
  } catch (e) {
    console.error("readStandards error:", e);
    return {};
  }
}
function writeStandards(obj) {
  fs.writeFileSync(STANDARDS_DB, JSON.stringify(obj, null, 2), "utf8");
}

// multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// express
const app = express();
app.use(cors());
app.use(express.json());

// init genkit + plugin (mirrors screenshot)
const API_KEY = process.env.GEMINI_API_KEY;
let ai = null;
try {
  if (genkit && googleAI) {
    ai = genkit({
      plugins: [
        googleAI({
          apiKey: API_KEY
        }),
      ],
      model: googleAI.model("gemini-2.5-flash", {
        temperature: 0.8
      }),
    });
    console.log("genkit initialized with googleAI plugin");
  } else {
    console.warn("genkit/googleAI plugin not available. ai will be null.");
  }
} catch (e) {
  console.warn("Failed to initialize genkit:", e.message);
}

// create fileManager instance if class exists (matches screenshot usage)
let fileManager = null;
try {
  if (GoogleAIFileManager) {
    fileManager = new GoogleAIFileManager(API_KEY);
    console.log("GoogleAIFileManager initialized");
  } else {
    console.warn("GoogleAIFileManager not available.");
  }
} catch (e) {
  console.warn("Failed to create GoogleAIFileManager:", e.message);
}

// Helper: use the screenshot-style upload API: fileManager.uploadFile(path, { mimeType, displayName })
async function uploadFileUsingManager(localPath, originalName) {
  if (!fileManager || typeof fileManager.uploadFile !== "function") {
    throw new Error("fileManager.uploadFile not available (check package exports / module type)");
  }

  const mimeType = mime.lookup(originalName) || "application/octet-stream";
  // Call the upload method as shown in your reference image
  const res = await fileManager.uploadFile(localPath, { mimeType, displayName: originalName });
  return { res, mimeType };
}

// POST /upload
app.post("/upload", upload.single("standardFile"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const localPath = req.file.path;
    const originalName = req.file.originalname;

    console.log("Received upload:", originalName, localPath);

    // Use the manager upload (as in screenshot)
    let uploadedInfo;
    try {
      const { res: uploadResult, mimeType } = await uploadFileUsingManager(localPath, originalName);
      uploadedInfo = { uploadResult, mimeType };
      console.log("UploadResult:", uploadResult);
    } catch (sdkErr) {
      console.error("Upload via GoogleAIFileManager failed:", sdkErr && sdkErr.message);
      // return error — user asked to keep the screenshot usage; don't auto-fallback here
      return res.status(500).json({ error: "SDK upload failed", details: String(sdkErr?.message || sdkErr) });
    }

    // extract fileUri from common shapes
    const uploaded = uploadedInfo.uploadResult || {};
    const fileUri =
      uploaded?.file?.uri ||
      uploaded?.file?.url ||
      uploaded?.uri ||
      uploaded?.name ||
      uploaded?.resourceName ||
      null;

    // persist mapping
    const map = readStandards();
    map[originalName] = { fileUri: fileUri || null, uploadedAt: new Date().toISOString(), raw: uploaded };
    writeStandards(map);

    // cleanup temp file
    try { fs.unlinkSync(localPath); } catch (e) { /* ignore */ }

    if (!fileUri) {
      return res.status(200).json({ message: "Uploaded but no fileUri in SDK response", raw: uploaded });
    }
    res.json({ filename: originalName, fileUri });
  } catch (err) {
    console.error("Upload route error:", err);
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

// GET /standards
app.get("/standards", (req, res) => {
  const map = readStandards();
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = v.fileUri || null;
  res.json(out);
});

// POST /summarize
app.post("/summarize", async (req, res) => {
  try {
    const { selectedStandards = [], prompt = "Summarize the documents." } = req.body;
    if (!Array.isArray(selectedStandards) || selectedStandards.length === 0) {
      return res.status(400).json({ error: "selectedStandards must be a non-empty array" });
    }

    const map = readStandards();
    const fileUris = selectedStandards.map(n => map[n]?.fileUri).filter(Boolean);
    if (fileUris.length === 0) return res.status(400).json({ error: "No fileUris found for selected standards" });

    // Build prompt parts like the screenshot: text then media parts
    const parts = [
      { text: prompt },
      ...fileUris.map(uri => ({ media: { contentType: "application/pdf", url: uri } }))
    ];

    // calling ai.generate similar to screenshot usage
    if (!ai) return res.status(500).json({ error: "AI client not initialized (genkit/googleAI plugin missing)" });

    // in screenshot they used: const { text } = await ai.generate({ model: googleAI.model("gemini-2.5-flash"), prompt: [ ... ] })
    // we'll attempt the same call shape:
    const model = googleAI ? googleAI.model("gemini-2.5-flash") : "gemini-2.5-flash";
    const genResp = await ai.generate({
      model,
      prompt: parts
    });

    // extract response text
    const text = genResp?.text || genResp?.output || genResp?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(genResp);

    res.json({ summary: text, raw: genResp });
  } catch (err) {
    console.error("Summarize error:", err);
    res.status(500).json({ error: "Summarization failed", details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
