// backend/index.js
// CommonJS. Requires installed packages:
// express, cors, multer, fs, path, mime-types, dotenv, axios, genkit, @genkit-ai/googleai, @google/generative-ai/server

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const dotenv = require("dotenv");
const axios = require("axios");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { genkit } = require("genkit");
const { googleAI } = require("@genkit-ai/googleai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { OAuth2Client } = require("google-auth-library");

const connectDatabase = require("./database");
const User = require("./models/User");
const Standard = require("./models/Standard");
const Requirement = require("./models/Requirement");
const GeneratedSet = require("./models/GeneratedSet");

dotenv.config();

const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* multer */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

/* express */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || undefined);

async function verifyGoogleCredential(idToken) {
  if (!idToken) {
    throw new Error("Missing Google credential");
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID is not configured on the backend");
  }

  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = await verifyGoogleCredential(token);
    if (!payload || !payload.sub) {
      throw new Error("Invalid Google token payload");
    }

    let user = await User.findOne({ googleId: payload.sub });
    const now = new Date();
    if (!user) {
      user = await User.create({
        googleId: payload.sub,
        email: payload.email,
        name: payload.name || payload.email || "User",
        picture: payload.picture,
        lastLoginAt: now,
      });
    } else {
      const updates = {};
      if (payload.email && payload.email !== user.email) updates.email = payload.email;
      if (payload.name && payload.name !== user.name) updates.name = payload.name;
      if (payload.picture && payload.picture !== user.picture) updates.picture = payload.picture;
      updates.lastLoginAt = now;
      user.set(updates);
      await user.save();
    }

    req.user = {
      id: user._id.toString(),
      googleId: user.googleId,
      email: user.email,
      name: user.name,
    };
    req.userDoc = user;

    return next();
  } catch (error) {
    console.error("Authentication failed:", error?.message || error);
    if (String(error?.message || "").includes("GOOGLE_CLIENT_ID")) {
      return res.status(500).json({ error: "Server configuration error", details: error.message });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* AI client init */
const API_KEY = process.env.GEMINI_API_KEY;
let ai = null;
try {
  if (genkit && googleAI) {
    ai = genkit({
      plugins: [
        googleAI({ apiKey: API_KEY })
      ],
      model: googleAI.model("gemini-2.5-flash", { temperature: 0.2 })
    });
    console.log("genkit initialized");
  } else {
    console.warn("genkit/googleAI not available; ai client is null");
  }
} catch (e) {
  console.warn("AI init failed:", e?.message || e);
}

/* file manager */
let fileManager = null;
try {
  if (GoogleAIFileManager) {
    fileManager = new GoogleAIFileManager(API_KEY);
    console.log("GoogleAIFileManager initialized");
  }
} catch (e) {
  console.warn("fileManager init failed:", e?.message || e);
}

async function uploadFileUsingManager(localPath, originalName) {
  if (!fileManager || typeof fileManager.uploadFile !== "function") {
    throw new Error("fileManager.uploadFile not available");
  }
  const mimeType = mime.lookup(originalName) || "application/octet-stream";
  const res = await fileManager.uploadFile(localPath, { mimeType, displayName: originalName });
  return { res, mimeType };
}

/* ------------------ STANDARDS (keep existing) ------------------ */

/**
 * POST /upload
 * Upload standard file in form-data field "standardFile"
 */
app.post("/upload", authenticate, upload.single("standardFile"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const localPath = req.file.path;
    const originalName = req.file.originalname;

    let uploaded;
    try {
      const { res: uploadRes } = await uploadFileUsingManager(localPath, originalName);
      uploaded = uploadRes;
    } catch (sdkErr) {
      console.error("Upload via fileManager failed:", sdkErr?.message || sdkErr);
      return res.status(500).json({ error: "SDK upload failed", details: String(sdkErr?.message || sdkErr) });
    }

    const fileUri =
      uploaded?.file?.uri ||
      uploaded?.file?.url ||
      uploaded?.uri ||
      uploaded?.name ||
      uploaded?.resourceName ||
      null;

    const user = req.userDoc;
    let record = await Standard.findOne({ user: user._id, filename: originalName });
    if (record) {
      record.fileUri = fileUri || null;
      record.uploadedAt = new Date();
      record.raw = uploaded;
      await record.save();
    } else {
      record = await Standard.create({
        user: user._id,
        filename: originalName,
        fileUri: fileUri || null,
        uploadedAt: new Date(),
        raw: uploaded,
      });
    }

    try { fs.unlinkSync(localPath); } catch (e) { /* ignore */ }

    res.json({ filename: record.filename, fileUri: record.fileUri });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

/**
 * GET /standards
 * Return map { filename: fileUri }
 */
app.get("/standards", authenticate, async (req, res) => {
  try {
    const records = await Standard.find({ user: req.userDoc._id })
      .sort({ filename: 1 })
      .select({ filename: 1, fileUri: 1 });
    const out = {};
    for (const doc of records) {
      out[doc.filename] = doc.fileUri || null;
    }
    res.json(out);
  } catch (err) {
    console.error("Fetch standards error:", err);
    res.status(500).json({ error: "Unable to load standards", details: String(err.message || err) });
  }
});

/* ------------------ REQUIREMENTS (now file-upload based) ------------------ */

/**
 * POST /requirements/upload
 * form-data: requirementFile
 * Response: { req_id, title, fileUri }
 */
app.post("/requirements/upload", authenticate, upload.single("requirementFile"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const localPath = req.file.path;
    const originalName = req.file.originalname;
    // optional: create title from filename (without extension)
    const title = req.body.title || originalName.replace(/\.[^/.]+$/, "");

    let uploaded;
    try {
      const { res: uploadRes } = await uploadFileUsingManager(localPath, originalName);
      uploaded = uploadRes;
    } catch (sdkErr) {
      console.error("Requirement upload via fileManager failed:", sdkErr?.message || sdkErr);
      return res.status(500).json({ error: "SDK upload failed", details: String(sdkErr?.message || sdkErr) });
    }

    const fileUri =
      uploaded?.file?.uri ||
      uploaded?.file?.url ||
      uploaded?.uri ||
      uploaded?.name ||
      uploaded?.resourceName ||
      null;

    // create a stable req_id
    const reqId = `REQ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const user = req.userDoc;
    const requirement = await Requirement.create({
      user: user._id,
      reqId,
      title,
      originalName,
      fileUri: fileUri || null,
      uploadedAt: new Date(),
      raw: uploaded,
    });

    try { fs.unlinkSync(localPath); } catch (e) { /* ignore */ }

    res.json({ req_id: requirement.reqId, title: requirement.title, fileUri: requirement.fileUri });
  } catch (err) {
    console.error("Requirement upload error:", err);
    res.status(500).json({ error: "Requirement upload failed", details: String(err) });
  }
});

/**
 * GET /requirements
 * Response: { reqId: { id, title, fileUri } }
 */
app.get("/requirements", authenticate, async (req, res) => {
  try {
    const records = await Requirement.find({ user: req.userDoc._id })
      .sort({ createdAt: -1 })
      .select({ reqId: 1, title: 1, fileUri: 1 });
    const out = {};
    for (const doc of records) {
      out[doc.reqId] = { id: doc.reqId, title: doc.title, fileUri: doc.fileUri };
    }
    res.json(out);
  } catch (err) {
    console.error("Fetch requirements error:", err);
    res.status(500).json({ error: "Unable to load requirements", details: String(err.message || err) });
  }
});

/* ------------------ TESTCASE GENERATION ------------------ */

/**
 * POST /testcases
 * Body: { selectedRequirements: [reqId], selectedStandards: [standardFilename], promptOverride? }
 * Behavior:
 *  - For each selected requirement, call AI with requirement + selected standards media + instruction
 *  - Expect strict JSON array back with objects matching requested schema fields
 *  - Normalize and persist; return a summary (list of req entries and their generated testcases counts)
 */
// ensure audit dir exists

async function downloadFileToBuffer(url, timeoutMs = 20000) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: timeoutMs,
    maxContentLength: 20 * 1024 * 1024
  });
  return Buffer.from(resp.data);
}

/**
 * Extract text from Buffer depending on file type
 */
async function extractTextFromBuffer(buffer, contentType = "", filename = "") {
  const ext = (filename || "").toLowerCase();

  try {
    if (contentType.includes("pdf") || ext.endsWith(".pdf")) {
      const data = await pdfParse(buffer);
      return data.text;
    }
    if (contentType.includes("word") || ext.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    if (contentType.startsWith("text") || ext.endsWith(".txt") || ext.endsWith(".md")) {
      return buffer.toString("utf8");
    }

    // Fallbacks
    try {
      const pdf = await pdfParse(buffer);
      if (pdf.text.trim()) return pdf.text;
    } catch (_) {}
    try {
      const docx = await mammoth.extractRawText({ buffer });
      if (docx.value.trim()) return docx.value;
    } catch (_) {}

    return buffer.toString("utf8").slice(0, 5000);
  } catch (err) {
    console.warn("extractTextFromBuffer failed:", err.message);
    return "";
  }
}

/**
 * Fetch + extract text from a remote file
 */
async function fetchAndExtract(url, filenameHint = "") {
  try {
    const buf = await downloadFileToBuffer(url);
    const text = await extractTextFromBuffer(buf, "", filenameHint);
    const MAX = 12000;
    const cleaned = (text || "").replace(/\s+/g, " ").trim();
    return cleaned.length > MAX ? cleaned.slice(0, MAX) : cleaned;
  } catch (err) {
    console.error("fetchAndExtract error:", err.message);
    return "";
  }
}

const AI_RAW_DIR = path.join(__dirname, 'ai_raw_logs');
if (!fs.existsSync(AI_RAW_DIR)) fs.mkdirSync(AI_RAW_DIR, { recursive: true });

// helper: extract first JSON block from text (handles code fences)
function extractFirstJson(text, retType) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  
  // Try to find a complete JSON object first (with balanced braces)
  if(retType === "object") {
    let braceCount = 0;
    let startIdx = -1;
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '{') {
        if (startIdx === -1) startIdx = i;
        braceCount++;
      } else if (cleaned[i] === '}') {
        braceCount--;
        if (braceCount === 0 && startIdx !== -1) {
          return cleaned.substring(startIdx, i + 1);
        }
      }
    }
  }
  
  // If no object found, try to find an array (with balanced brackets)
  let bracketCount = 0;
  startIdx = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '[') {
      if (startIdx === -1) startIdx = i;
      bracketCount++;
    } else if (cleaned[i] === ']') {
      bracketCount--;
      if (bracketCount === 0 && startIdx !== -1) {
        return cleaned.substring(startIdx, i + 1);
      }
    }
  }
  
  return null;
}

// normalize to your exact schema
function normalizeTestcaseForStore(t, reqId) {
  const tc_id = typeof t.tc_id === 'string' ? t.tc_id : (t.id || `TC-${Date.now()}-${Math.floor(Math.random()*1000)}`);
  const req_id = t.req_id || reqId;
  const jira_id = t.jira_id;
  const title = t.title || `Testcase ${tc_id}`;
  const preconditions = Array.isArray(t.preconditions) ? t.preconditions.map(String) : [];
  const steps = Array.isArray(t.steps) ? t.steps.map(String) : [];
  const expected = typeof t.expected === 'string' ? t.expected : (Array.isArray(t.expected) ? t.expected.join(' ') : '');
  const automatable = typeof t.automatable === 'boolean' ? t.automatable : false;
  const suggested_tool = typeof t.suggested_tool === 'string' ? t.suggested_tool : 'manual';
  let confidence = parseFloat(t.confidence);
  confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.0;
  const compliance = Array.isArray(t.compliance) ? t.compliance.map(String) : [];
  return { tc_id, req_id, jira_id, title, preconditions, steps, expected, automatable, suggested_tool, confidence, compliance };
}

app.post("/testcases", authenticate, async (req, res) => {
  try {
    const { selectedRequirements = [], selectedStandards = [], promptOverride } = req.body;
    if (!Array.isArray(selectedRequirements) || selectedRequirements.length === 0) {
      return res.status(400).json({ error: "selectedRequirements must be provided" });
    }
    if (!Array.isArray(selectedStandards) || selectedStandards.length === 0) {
      return res.status(400).json({ error: "selectedStandards must be provided" });
    }

    const userId = req.userDoc._id;
    const requirements = await Requirement.find({
      user: userId,
      reqId: { $in: selectedRequirements },
    });
    const requirementsById = new Map(requirements.map((doc) => [doc.reqId, doc]));

    const standards = await Standard.find({
      user: userId,
      filename: { $in: selectedStandards },
    });
    const standardsByName = new Map(standards.map((doc) => [doc.filename, doc]));

    const results = [];

    // strict instruction (you can tweak wording)
    const defaultInstruction = `You are a senior QA engineer for regulated healthcare software. Using ONLY the extracted text blocks provided below, return EXACTLY a JSON array (no commentary, no markdown) of testcases. Each testcase must have these fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array). Provide 2-8 testcases. Use req_id provided.`;

    const model = googleAI ? googleAI.model("gemini-2.5-flash") : "gemini-2.5-flash";

    for (const reqId of selectedRequirements) {
      const reqEntry = requirementsById.get(reqId);
      if (!reqEntry) {
        results.push({ req_id: reqId, success: false, error: "requirement not found" });
        continue;
      }

      // fetch/extract the requirement text (reuse your fetchAndExtract helper)
      const reqText = reqEntry.fileUri
        ? await fetchAndExtract(reqEntry.fileUri, reqEntry.originalName || reqEntry.title)
        : "";

      // fetch/extract selected standard texts
      const standardsTexts = [];
      for (const sName of selectedStandards) {
        const stdEntry = standardsByName.get(sName);
        if (!stdEntry?.fileUri) continue;
        const txt = await fetchAndExtract(stdEntry.fileUri, sName);
        const short = sName.replace(/\.[^/.]+$/, "");
        standardsTexts.push({ name: short, text: txt });
      }

      // compose prompt parts (text blocks)
      const instructionParts = [{ text: defaultInstruction }];
      if (promptOverride && typeof promptOverride === "string" && promptOverride.trim()) {
        instructionParts.push({ text: `Additional user instructions:\n${promptOverride.trim()}` });
      }

      const parts = [
        ...instructionParts,
        { text: `Requirement metadata:\nreq_id: ${reqId}\ntitle: ${reqEntry.title}\n\nRequirement text:\n${reqText || "<no extracted text>"}\n` },
        { text: `Standards list: ${selectedStandards.join(", ")}` }
      ];
      for (const s of standardsTexts) parts.push({ text: `Standard: ${s.name}\n\n${s.text || "<no extracted text>"}\n` });
      parts.push({ text: "Return ONLY the JSON array." });

      if (!ai) {
        results.push({ req_id: reqId, success: false, error: "AI client not initialized" });
        continue;
      }

      // call AI
      const genResp = await ai.generate({ model, prompt: parts });
      const candidateText = genResp?.text || genResp?.output || genResp?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      // audit log the raw text for debugging (do not return to client)
      try {
        const auditFile = path.join(AI_RAW_DIR, `${reqId}-${Date.now()}.log`);
        fs.appendFileSync(auditFile, `--- RAW RESPONSE ---\n${candidateText}\n\n--- FULL GEN RESP ---\n${JSON.stringify(genResp, null, 2)}\n`);
      } catch (e) { /* ignore audit failures */ }

      // attempt parse -> extract JSON block
      let parsed = null;
      const jsonBlock = extractFirstJson(candidateText, "array");
      if (jsonBlock) {
        try { parsed = JSON.parse(jsonBlock); } catch (e) { parsed = null; }
      }

      // retry once with an extremely strict short instruction if parsing failed
      if (!Array.isArray(parsed)) {
        const retryParts = [
          { text: "IMPORTANT: Return ONLY a JSON array and NOTHING ELSE. No text, no markdown. The array must contain objects with fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array)." },
          { text: defaultInstruction }
        ];
        if (promptOverride && typeof promptOverride === "string" && promptOverride.trim()) {
          retryParts.push({ text: `Additional user instructions:\n${promptOverride.trim()}` });
        }
        retryParts.push({ text: `Requirement: ${reqId}\n${reqText}` });
        retryParts.push(...standardsTexts.map(s => ({ text: `Standard: ${s.name}\n\n${s.text || "<no text>"}\n` })));
        const retryResp = await ai.generate({ model, prompt: retryParts });
        const retryText = retryResp?.text || retryResp?.output || JSON.stringify(retryResp);
        // append retry to audit
        try { fs.appendFileSync(path.join(AI_RAW_DIR, `${reqId}-${Date.now()}-retry.log`), retryText); } catch (e) {}
        const retryBlock = extractFirstJson(retryText, "array");
        if (retryBlock) {
          try { parsed = JSON.parse(retryBlock); } catch (e) { parsed = null; }
        }
      }

      if (!Array.isArray(parsed)) {
        // do not store raw; return parse error for this requirement
        results.push({ req_id: reqId, title: reqEntry.title, success: false, error: "AI did not return parseable JSON after retry. See server audit logs." });
        continue;
      }

      // normalize and store
      const normalized = parsed.map((t, idx) => normalizeTestcaseForStore(t, reqId));
      const savedEntry = await GeneratedSet.create({
        user: userId,
        requirement: reqEntry._id,
        requirementId: reqEntry.reqId,
        requirementTitle: reqEntry.title,
        selectedStandards,
        testcases: normalized,
        promptOverride: promptOverride || undefined,
      });

      results.push({
        req_id: reqId,
        title: reqEntry.title,
        success: true,
        genId: savedEntry._id.toString(),
        count: normalized.length,
      });
    }

    return res.json({ success: true, results });
  } catch (err) {
    console.error("testcases generation error:", err);
    return res.status(500).json({ error: "Testcase generation failed", details: String(err) });
  }
});


/* ------------------ GET generated sets summary & by requirement ------------------ */

/**
 * GET /generated
 * List generated sets (summary)
 */
app.get("/generated", authenticate, async (req, res) => {
  try {
    const generated = await GeneratedSet.find({ user: req.userDoc._id }).sort({ createdAt: -1 });
    const summary = generated.map((g) => ({
      id: g._id.toString(),
      requirementId: g.requirementId,
      jiraId: g.jiraId,
      requirementTitle: g.requirementTitle,
      createdAt: g.createdAt,
      count: (g.testcases || []).length,
    }));
    res.json(summary);
  } catch (err) {
    console.error("Fetch generated summary error:", err);
    res.status(500).json({ error: "Unable to load generated sets", details: String(err.message || err) });
  }
});

/**
 * GET /generated/requirement/:reqId
 * Return testcases array for that requirement (latest generated set for requirement)
 */
app.get("/generated/requirement/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const entry = await GeneratedSet.findOne({ _id: id, user: req.userDoc._id });
    if (!entry) {
      return res.status(404).json({ error: "No generated testcases found for this requirement" });
    }
    return res.json({
      id: entry._id.toString(),
      requirementId: entry.requirementId,
      jiraId: entry.jiraId,
      requirementTitle: entry.requirementTitle,
      testcases: entry.testcases || [],
      selectedStandards: entry.selectedStandards || [],
    });
  } catch (err) {
    console.error("Fetch generated by requirement error:", err);
    res.status(500).json({ error: "Unable to load generated testcases", details: String(err.message || err) });
  }
});

/* ------------------ Regenerate single testcase (keeps tc_id) ------------------ */

/**
 * POST /testcases/:genId/regenerate/:tcId
 * Body optional: { promptOverride }
 * Replaces the single testcase object (must return single JSON object).
 */
app.post("/testcases/:genId/regenerate/:tcId", authenticate, async (req, res) => {
  try {
    const { genId, tcId } = req.params;
    const { promptOverride } = req.body || {};
    const genEntry = await GeneratedSet.findOne({ _id: genId, user: req.userDoc._id });
    if (!genEntry) return res.status(404).json({ error: "Generated set not found" });

    const tcIndex = genEntry.testcases.findIndex(t => t.tc_id === tcId);
    if (tcIndex === -1) return res.status(404).json({ error: "Testcase id not found" });

    const existingTc = genEntry.testcases[tcIndex];
    
    // Fetch requirement document
    const reqEntry = genEntry.requirement
      ? await Requirement.findOne({ _id: genEntry.requirement, user: req.userDoc._id })
      : await Requirement.findOne({ user: req.userDoc._id, reqId: genEntry.requirementId });
    if (!reqEntry) return res.status(404).json({ error: "Requirement not found" });

    // Fetch requirement text
    const reqText = reqEntry.fileUri
      ? await fetchAndExtract(reqEntry.fileUri, reqEntry.originalName || reqEntry.title)
      : "";

    // Fetch standard documents
    const standardDocs = await Standard.find({
      user: req.userDoc._id,
      filename: { $in: genEntry.selectedStandards || [] },
    });
    const standardsTexts = [];
    for (const stdDoc of standardDocs) {
      if (stdDoc.fileUri) {
        const txt = await fetchAndExtract(stdDoc.fileUri, stdDoc.filename);
        standardsTexts.push({ name: stdDoc.filename, text: txt });
      }
    }

    const model = googleAI ? googleAI.model("gemini-2.5-flash") : "gemini-2.5-flash";

    // Build comprehensive prompt with full context
    const baseInstruction = `You are a QA engineer. Regenerate and improve the testcase with ID "${tcId}" from the following context. Return ONLY a JSON object (no markdown, no extra text) with these exact fields:
- tc_id: must be "${tcId}" (keep this exact value)
- req_id: "${existingTc.req_id || genEntry.requirementId}"
- jira_id: "${existingTc.jira_id || ""}"
- title: string
- preconditions: array of strings
- steps: array of strings
- expected: string
- automatable: boolean
- suggested_tool: string
- confidence: number between 0 and 1
- compliance: array of strings

REQUIREMENT:
ID: ${reqEntry.reqId}
Title: ${reqEntry.title}
Content: ${reqText || "<no content available>"}

STANDARDS USED:
${standardsTexts.map(s => `${s.name}:\n${s.text || "<no content available>"}`).join("\n\n---\n\n") || "No standards available"}

GENERATED TEST CASE SET:
All testcases in this set:
${JSON.stringify(genEntry.testcases, null, 2)}

TARGET TESTCASE TO REGENERATE (ID: ${tcId}):
${JSON.stringify(existingTc, null, 2)}`;

    const instructionParts = [baseInstruction];
    if (promptOverride && typeof promptOverride === "string" && promptOverride.trim()) {
      instructionParts.push(`ADDITIONAL USER INSTRUCTIONS:\n${promptOverride.trim()}`);
    }
    const finalInstruction = instructionParts.join("\n\n");

    if (!ai) return res.status(500).json({ error: "AI client not initialized" });

    const parts = [{ text: finalInstruction }];

    // Also attach requirement and standards as media if available
    if (reqEntry.fileUri) parts.push({ media: { contentType: "application/pdf", url: reqEntry.fileUri } });
    for (const stdDoc of standardDocs) {
      if (stdDoc.fileUri) parts.push({ media: { contentType: "application/pdf", url: stdDoc.fileUri } });
    }

    const genResp = await ai.generate({ model, prompt: parts });
    const candidateText =
      genResp?.text ||
      genResp?.output ||
      genResp?.candidates?.[0]?.content?.parts?.[0]?.text ||
      JSON.stringify(genResp);

    // Extract JSON block (handles markdown code fences and extra text)
    let parsed = null;
    const jsonBlock = extractFirstJson(candidateText, "object");
    if (jsonBlock) {
      try { parsed = JSON.parse(jsonBlock); } catch (e) { 
        console.error("JSON parse error:", e.message);
        parsed = null; 
      }
    }

    // Retry if parsing failed or got an array instead of object
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const retryInstruction = `CRITICAL: Return ONLY a valid JSON object (not an array, no markdown code blocks, no extra text before or after). The JSON object must have these exact fields:
{
  "tc_id": "${tcId}",
  "req_id": "${existingTc.req_id || genEntry.requirementId}",
  "jira_id": "${existingTc.jira_id || ""}",
  "title": "string",
  "preconditions": ["string1", "string2"],
  "steps": ["step1", "step2"],
  "expected": "string",
  "automatable": true/false,
  "suggested_tool": "string",
  "confidence": 0.8,
  "compliance": ["string1", "string2"]
}

REQUIREMENT: ${reqEntry.reqId} - ${reqEntry.title}
${reqText || ""}

STANDARDS:
${standardsTexts.map(s => `${s.name}:\n${s.text || ""}`).join("\n\n")}

ALL TESTCASES IN SET:
${JSON.stringify(genEntry.testcases, null, 2)}

REGENERATE THIS TESTCASE (ID: ${tcId}):
${JSON.stringify(existingTc, null, 2)}`;
      
      if (promptOverride && typeof promptOverride === "string" && promptOverride.trim()) {
        retryInstruction += `\n\nADDITIONAL USER INSTRUCTIONS:\n${promptOverride.trim()}`;
      }

      const retryParts = [{ text: retryInstruction }];
      if (reqEntry.fileUri) retryParts.push({ media: { contentType: "application/pdf", url: reqEntry.fileUri } });
      for (const stdDoc of standardDocs) {
        if (stdDoc.fileUri) retryParts.push({ media: { contentType: "application/pdf", url: stdDoc.fileUri } });
      }

      const retryResp = await ai.generate({ model, prompt: retryParts });
      const retryText = retryResp?.text || retryResp?.output || JSON.stringify(retryResp);
      const retryBlock = extractFirstJson(retryText, "object");
      if (retryBlock) {
        try { parsed = JSON.parse(retryBlock); } catch (e) { 
          console.error("Retry JSON parse error:", e.message);
          parsed = null; 
        }
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return res.status(500).json({ error: "AI did not return a valid JSON object for the testcase" });
    }

    // normalize and ensure tc_id preserved
    const newTc = {
      tc_id: tcId, // Always preserve the original tc_id
      req_id: parsed.req_id || existingTc.req_id || genEntry.requirementId,
      jira_id: parsed.jira_id !== undefined ? String(parsed.jira_id) : (existingTc.jira_id || ""),
      title: parsed.title || existingTc.title || `Testcase ${tcId}`,
      preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions.map(String) : (Array.isArray(existingTc.preconditions) ? existingTc.preconditions : []),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : (Array.isArray(existingTc.steps) ? existingTc.steps : []),
      expected: typeof parsed.expected === "string" ? parsed.expected : (existingTc.expected || ""),
      automatable: typeof parsed.automatable === "boolean" ? parsed.automatable : (typeof existingTc.automatable === "boolean" ? existingTc.automatable : false),
      suggested_tool: typeof parsed.suggested_tool === "string" ? parsed.suggested_tool : (existingTc.suggested_tool || "manual"),
      confidence: Number.isFinite(parseFloat(parsed.confidence)) ? Math.max(0, Math.min(1, parseFloat(parsed.confidence))) : (Number.isFinite(existingTc.confidence) ? existingTc.confidence : 0.0),
      compliance: Array.isArray(parsed.compliance) ? parsed.compliance.map(String) : (Array.isArray(existingTc.compliance) ? existingTc.compliance : [])
    };

    // replace the testcase in the database
    genEntry.testcases[tcIndex] = newTc;
    genEntry.markModified("testcases");
    await genEntry.save();

    res.json({ success: true, testcase: newTc });
  } catch (err) {
    console.error("regenerate single testcase error:", err);
    res.status(500).json({ error: "Regeneration failed", details: String(err) });
  }
});

/* ------------------ Regenerate testcases for a requirement ------------------ */

/**
 * POST /requirements/:reqId/regenerate
 * Body: { selectedStandards: [standardFilename], promptOverride? }
 * Generates a new set of testcases for the requirement
 */
app.post("/requirements/:reqId/regenerate", authenticate, async (req, res) => {
  try {
    const { reqId } = req.params;
    const { selectedStandards = [], promptOverride } = req.body || {};
    
    if (!Array.isArray(selectedStandards) || selectedStandards.length === 0) {
      return res.status(400).json({ error: "selectedStandards must be provided" });
    }

    const userId = req.userDoc._id;
    
    // Find the requirement
    const reqEntry = await Requirement.findOne({
      user: userId,
      reqId: reqId,
    });
    if (!reqEntry) {
      return res.status(404).json({ error: "Requirement not found" });
    }

    // Fetch requirement text
    const reqText = reqEntry.fileUri
      ? await fetchAndExtract(reqEntry.fileUri, reqEntry.originalName || reqEntry.title)
      : "";

    // Fetch standard documents
    const standards = await Standard.find({
      user: userId,
      filename: { $in: selectedStandards },
    });
    const standardsByName = new Map(standards.map((doc) => [doc.filename, doc]));
    const standardsTexts = [];
    for (const sName of selectedStandards) {
      const stdEntry = standardsByName.get(sName);
      if (!stdEntry?.fileUri) continue;
      const txt = await fetchAndExtract(stdEntry.fileUri, sName);
      const short = sName.replace(/\.[^/.]+$/, "");
      standardsTexts.push({ name: short, text: txt });
    }

    const model = googleAI ? googleAI.model("gemini-2.5-flash") : "gemini-2.5-flash";

    // Build instruction
    const defaultInstruction = `You are a senior QA engineer for regulated healthcare software. Using ONLY the extracted text blocks provided below, return EXACTLY a JSON array (no commentary, no markdown) of testcases. Each testcase must have these fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array). Provide minimum 2 testcases. Decide the max number of testcases based on the size of the requirements. You are free to produce as many testcases as required. Use req_id: ${reqId}.`;
    
    const instructionParts = [defaultInstruction];
    if (promptOverride && typeof promptOverride === "string" && promptOverride.trim()) {
      instructionParts.push(`Additional user instructions:\n${promptOverride.trim()}`);
    }
    const baseInstruction = instructionParts.join("\n\n");

    // Compose prompt parts
    const parts = [
      { text: baseInstruction },
      { text: `Requirement metadata:\nreq_id: ${reqId}\ntitle: ${reqEntry.title}\n\nRequirement text:\n${reqText || "<no extracted text>"}\n` },
      { text: `Standards list: ${selectedStandards.join(", ")}` }
    ];
    for (const s of standardsTexts) parts.push({ text: `Standard: ${s.name}\n\n${s.text || "<no extracted text>"}\n` });
    parts.push({ text: "Return ONLY the JSON array." });

    // Attach requirement and standards as media if available
    if (reqEntry.fileUri) parts.push({ media: { contentType: "application/pdf", url: reqEntry.fileUri } });
    for (const sName of selectedStandards) {
      const stdEntry = standardsByName.get(sName);
      if (stdEntry?.fileUri) parts.push({ media: { contentType: "application/pdf", url: stdEntry.fileUri } });
    }

    if (!ai) {
      return res.status(500).json({ error: "AI client not initialized" });
    }

    // Call AI
    const genResp = await ai.generate({ model, prompt: parts });
    const candidateText = genResp?.text || genResp?.output || genResp?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(genResp);
    console.log("Candidate Text ->", candidateText);

    // Audit log the raw text for debugging
    try {
      const auditFile = path.join(AI_RAW_DIR, `${reqId}-regenerate-${Date.now()}.log`);
      fs.appendFileSync(auditFile, `--- RAW RESPONSE ---\n${candidateText}\n\n--- FULL GEN RESP ---\n${JSON.stringify(genResp, null, 2)}\n`);
    } catch (e) { /* ignore audit failures */ }

    // Attempt parse -> extract JSON block
    let parsed = null;
    const jsonBlock = extractFirstJson(candidateText, "array");
    console.log("JSON Block ->", jsonBlock);
    if (jsonBlock) {
      try { parsed = JSON.parse(jsonBlock); } catch (e) { console.log("Parsed error"); parsed = null; }
    }
    console.log("Parsed ->", parsed);
    // Retry once with an extremely strict short instruction if parsing failed
    if (!Array.isArray(parsed)) {
      const retryInstructionParts = [
        "IMPORTANT: Return ONLY a JSON array and NOTHING ELSE. No text, no markdown. The array must contain objects with fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array)."
      ];
      if (promptOverride && typeof promptOverride === "string" && promptOverride.trim()) {
        retryInstructionParts.push(`Additional user instructions:\n${promptOverride.trim()}`);
      }
      
      const retryParts = [
        { text: retryInstructionParts.join("\n\n") },
        { text: `Requirement: ${reqId}\n${reqText}` },
        ...standardsTexts.map(s => ({ text: `Standard: ${s.name}\n\n${s.text || "<no text>"}\n` }))
      ];
      if (reqEntry.fileUri) retryParts.push({ media: { contentType: "application/pdf", url: reqEntry.fileUri } });
      for (const sName of selectedStandards) {
        const stdEntry = standardsByName.get(sName);
        if (stdEntry?.fileUri) retryParts.push({ media: { contentType: "application/pdf", url: stdEntry.fileUri } });
      }

      const retryResp = await ai.generate({ model, prompt: retryParts });
      const retryText = retryResp?.text || retryResp?.output || JSON.stringify(retryResp);
      // append retry to audit
      try { fs.appendFileSync(path.join(AI_RAW_DIR, `${reqId}-regenerate-${Date.now()}-retry.log`), retryText); } catch (e) {}
      const retryBlock = extractFirstJson(retryText, "array");
      if (retryBlock) {
        try { parsed = JSON.parse(retryBlock); } catch (e) { parsed = null; }
      }
    }

    if (!Array.isArray(parsed)) {
      return res.status(500).json({ error: "AI did not return parseable JSON after retry. See server audit logs." });
    }

    // Normalize and store (overwrite if a set already exists for this requirement)
    const normalized = parsed.map((t) => normalizeTestcaseForStore(t, reqId));

    // Try to find the latest existing generated set for this requirement
    let savedEntry = await GeneratedSet.findOne({
      user: userId,
      requirementId: reqEntry.reqId,
    }).sort({ createdAt: -1 });

    if (savedEntry) {
      // OVERWRITE existing set
      savedEntry.requirement = reqEntry._id;
      savedEntry.requirementId = reqEntry.reqId;
      savedEntry.requirementTitle = reqEntry.title;
      savedEntry.selectedStandards = selectedStandards;
      savedEntry.testcases = normalized;
      savedEntry.promptOverride = promptOverride || undefined;
      await savedEntry.save();
    } else {
      // Fallback: create if none exists
      savedEntry = await GeneratedSet.create({
        user: userId,
        requirement: reqEntry._id,
        requirementId: reqEntry.reqId,
        requirementTitle: reqEntry.title,
        selectedStandards,
        testcases: normalized,
        promptOverride: promptOverride || undefined,
      });
    }

    res.json({
      success: true,
      genId: savedEntry._id.toString(), // stays the same when overwriting
      count: normalized.length,
      requirementId: reqId,
      requirementTitle: reqEntry.title,
    });

  } catch (err) {
    console.error("regenerate requirement testcases error:", err);
    res.status(500).json({ error: "Regeneration failed", details: String(err) });
  }
});

/* ------------------ PATCH single testcase (manual update) ------------------ */

/**
 * PATCH /testcases/:genId/:tcId
 * body: fields to update (title, preconditions, steps, expected, automatable, suggested_tool, confidence, compliance)
 */
app.patch("/testcases/:genId/:tcId", authenticate, async (req, res) => {
  try {
    const { genId, tcId } = req.params;
    const updates = req.body || {};
    const genEntry = await GeneratedSet.findOne({ _id: genId, user: req.userDoc._id });
    if (!genEntry) return res.status(404).json({ error: "Generated set not found" });
    const idx = genEntry.testcases.findIndex((t) => t.tc_id === tcId);
    if (idx === -1) return res.status(404).json({ error: "Testcase id not found" });

    const tc = genEntry.testcases[idx];
    if (updates.title) tc.title = String(updates.title);
    if (updates.preconditions) tc.preconditions = Array.isArray(updates.preconditions) ? updates.preconditions.map(String) : [String(updates.preconditions)];
    if (updates.steps) tc.steps = Array.isArray(updates.steps) ? updates.steps.map(String) : [String(updates.steps)];
    if (typeof updates.expected !== "undefined") tc.expected = String(updates.expected);
    if (typeof updates.automatable === "boolean") tc.automatable = updates.automatable;
    if (updates.suggested_tool) tc.suggested_tool = String(updates.suggested_tool);
    if (typeof updates.confidence !== "undefined") {
      const c = parseFloat(updates.confidence);
      if (Number.isFinite(c)) tc.confidence = Math.max(0, Math.min(1, c));
    }
    if (updates.compliance) tc.compliance = Array.isArray(updates.compliance) ? updates.compliance.map(String) : [String(updates.compliance)];

    genEntry.markModified("testcases");
    await genEntry.save();
    res.json({ success: true, testcase: tc });
  } catch (err) {
    console.error("patch testcase error:", err);
    res.status(500).json({ error: "Update failed", details: String(err.message || err) });
  }
});

/* ------------------ JIRA (unchanged) ------------------ */

/**
 * POST /testcases/:genId/:tcId/jira
 * create jira issue for a single testcase (body may include projectKey, issueType, assignee)
 */
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PROJ = process.env.JIRA_PROJECT_KEY;
app.post("/testcases/:genId/:tcId/jira", authenticate, async (req, res) => {
  try {
    const { genId, tcId } = req.params;
    const { issueType = "Task", assignee, projectKey } = req.body || {};

    if (!JIRA_BASE_URL || !JIRA_USER_EMAIL || !JIRA_API_TOKEN || !PROJ) {
      return res.status(400).json({ error: "Jira credentials/project not configured in env" });
    }

    const genEntry = await GeneratedSet.findOne({ _id: genId, user: req.userDoc._id });
    if (!genEntry) return res.status(404).json({ error: "Generated set not found" });

    const rqId = genEntry.requirementId;

    // 1) create parent task if missing
    let parentKey = genEntry.jiraId || "";
    if (!parentKey) {
      const taskResp = await createJiraTask(genEntry); // await!
      // Jira create response often has .data.key
      parentKey = taskResp?.data?.key || taskResp?.data?.id || (typeof taskResp?.data === "string" ? taskResp.data : null);
      if (!parentKey) {
        // fallback: put entire data for debugging
        parentKey = JSON.stringify(taskResp?.data || taskResp);
      }

      await GeneratedSet.updateMany(
        { user: genEntry.user, requirementId: rqId },
        { $set: { jiraId: parentKey } }
      );
      genEntry.jiraId = parentKey;
    }

    // 2) create subtask for the testcase
    const tc = genEntry.testcases.find((t) => t.tc_id === tcId);
    if (!tc) return res.status(404).json({ error: "Testcase id not found" });

    // ensure genEntry.jiraId is set to parentKey before calling subtask (some helper expects it)
    genEntry.jiraId = parentKey;

    const subResp = await createJiraSubTask(genEntry, tcId); // await!
    const subKey = subResp?.data?.key || subResp?.data?.id || (typeof subResp?.data === "string" ? subResp.data : null);

    // persist subtask id into the testcase (use jira_id field on testcase)
    tc.jira_id = subKey || JSON.stringify(subResp?.data || subResp);

    genEntry.markModified("testcases");
    await genEntry.save();

    return res.json({ success: true, jira: { parent: parentKey, subtask: tc.jira_id } });
  } catch (err) {
    console.error("jira create error:", err?.response?.data || err.message || err);
    return res.status(500).json({
      error: "Jira creation failed",
      details: err?.response?.data || String(err),
    });
  }
});

// ---------- Safe helpers: throw on error, do not use `res` ----------
async function createJiraTask(genEntry) {
  if (!genEntry || !genEntry.requirementId) {
    throw new Error("Requirement id not found on genEntry");
  }

  const summary = `Requirement: ${genEntry.requirementTitle || genEntry.requirementId}`;
  const description = [
    `*Requirement ID*: ${genEntry.requirementId}`,
    `*Requirement*: ${genEntry.requirementTitle || ""}`,
    `*Standards*: ${(genEntry.selectedStandards || []).join(", ")}`,
  ].join("\n\n");

  const payload = {
    fields: {
      project: { key: PROJ },
      summary,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      },
      issuetype: { name: "Task" },
    },
  };

  const auth = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const jiraUrl = `${JIRA_BASE_URL}/rest/api/3/issue`;

  const r = await axios.post(jiraUrl, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + auth,
    },
  });
  return r; // axios response
}

async function createJiraSubTask(genEntry, tcId) {
  // return axios response or throw
  const tc = genEntry.testcases.find((t) => t.tc_id === tcId);
  if (!tc) throw new Error("Testcase id not found");

  if (!genEntry.jiraId) throw new Error("Parent Jira (genEntry.jiraId) not set");

  const summary = `Testcase: ${tc.title || tc.tc_id}`;
  const description = [
    `*Requirement*: ${genEntry.requirementTitle}`,
    `*Testcase ID*: ${tc.tc_id}`,
    `*Preconditions*:\n${(tc.preconditions || []).map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
    `*Steps*:\n${(tc.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `*Expected*:\n${tc.expected || ""}`,
    `*Standards*: ${(tc.compliance || []).join(", ")}`,
    `*Automatable*: ${tc.automatable ? "Yes" : "No"}`,
    `*Suggested Tool*: ${tc.suggested_tool || ""}`,
    `*Confidence*: ${typeof tc.confidence === "number" ? tc.confidence : ""}`,
  ].join("\n\n");

  const payload = {
    fields: {
      project: { key: PROJ },
      parent: { key: genEntry.jiraId },
      summary,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      },
      issuetype: { name: "Subtask" },
    },
  };

  const auth = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const jiraUrl = `${JIRA_BASE_URL}/rest/api/3/issue`;

  const r = await axios.post(jiraUrl, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + auth,
    },
  });
  return r;
}


/* health */
app.get("/", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

/* start */
connectDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });
