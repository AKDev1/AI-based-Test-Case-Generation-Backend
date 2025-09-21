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
const { genkit } = require("genkit");
const { googleAI } = require("@genkit-ai/googleai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");

dotenv.config();

const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const STANDARDS_DB = path.join(__dirname, "standards.json");
const REQUIREMENTS_DB = path.join(__dirname, "requirements.json");
const GENERATED_DB = path.join(__dirname, "generated_tests.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(STANDARDS_DB)) fs.writeFileSync(STANDARDS_DB, JSON.stringify({}, null, 2));
if (!fs.existsSync(REQUIREMENTS_DB)) fs.writeFileSync(REQUIREMENTS_DB, JSON.stringify({}, null, 2));
if (!fs.existsSync(GENERATED_DB)) fs.writeFileSync(GENERATED_DB, JSON.stringify([], null, 2));

function readJson(p, fallback) {
  try {
    const txt = fs.readFileSync(p, "utf8") || "";
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch (e) {
    console.error("readJson error", p, e);
    return fallback;
  }
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

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
app.post("/upload", upload.single("standardFile"), async (req, res) => {
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

    const map = readJson(STANDARDS_DB, {});
    map[originalName] = { fileUri: fileUri || null, uploadedAt: new Date().toISOString(), raw: uploaded };
    writeJson(STANDARDS_DB, map);

    try { fs.unlinkSync(localPath); } catch (e) { /* ignore */ }

    res.json({ filename: originalName, fileUri });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

/**
 * GET /standards
 * Return map { filename: fileUri }
 */
app.get("/standards", (req, res) => {
  const map = readJson(STANDARDS_DB, {});
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = v.fileUri || null;
  res.json(out);
});

/* ------------------ REQUIREMENTS (now file-upload based) ------------------ */

/**
 * POST /requirements/upload
 * form-data: requirementFile
 * Response: { req_id, title, fileUri }
 */
app.post("/requirements/upload", upload.single("requirementFile"), async (req, res) => {
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
    const reqId = `REQ-${Date.now()}`;

    const map = readJson(REQUIREMENTS_DB, {});
    // map shape: { reqId: { id:reqId, title, originalName, fileUri, uploadedAt, raw } }
    map[reqId] = { id: reqId, title, originalName, fileUri: fileUri || null, uploadedAt: new Date().toISOString(), raw: uploaded };
    writeJson(REQUIREMENTS_DB, map);

    try { fs.unlinkSync(localPath); } catch (e) { /* ignore */ }

    res.json({ req_id: reqId, title, fileUri });
  } catch (err) {
    console.error("Requirement upload error:", err);
    res.status(500).json({ error: "Requirement upload failed", details: String(err) });
  }
});

/**
 * GET /requirements
 * Response: { reqId: { id, title, fileUri } }
 */
app.get("/requirements", (req, res) => {
  const map = readJson(REQUIREMENTS_DB, {});
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = { id: v.id, title: v.title, fileUri: v.fileUri };
  res.json(out);
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
function extractFirstJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const arrayMatch = cleaned.match(/(\[\s*[\s\S]*\])/m);
  if (arrayMatch) return arrayMatch[1];
  const objMatch = cleaned.match(/(\{\s*[\s\S]*\})/m);
  if (objMatch) return objMatch[1];
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

app.post("/testcases", async (req, res) => {
  try {
    const { selectedRequirements = [], selectedStandards = [], promptOverride } = req.body;
    if (!Array.isArray(selectedRequirements) || selectedRequirements.length === 0) {
      return res.status(400).json({ error: "selectedRequirements must be provided" });
    }
    if (!Array.isArray(selectedStandards) || selectedStandards.length === 0) {
      return res.status(400).json({ error: "selectedStandards must be provided" });
    }

    const reqMap = readJson(REQUIREMENTS_DB, {});
    const stdMap = readJson(STANDARDS_DB, {});
    const generated = readJson(GENERATED_DB, []);

    const results = [];

    // strict instruction (you can tweak wording)
    const baseInstruction = promptOverride && typeof promptOverride === "string"
      ? promptOverride
      : `You are a senior QA engineer for regulated healthcare software. Using ONLY the extracted text blocks provided below, return EXACTLY a JSON array (no commentary, no markdown) of testcases. Each testcase must have these fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array). Provide 2-8 testcases. Use req_id provided.`;

    const model = googleAI ? googleAI.model("gemini-2.5-flash") : "gemini-2.5-flash";

    for (const reqId of selectedRequirements) {
      const reqEntry = reqMap[reqId];
      if (!reqEntry) { results.push({ req_id: reqId, success: false, error: "requirement not found" }); continue; }

      // fetch/extract the requirement text (reuse your fetchAndExtract helper)
      const reqText = reqEntry.fileUri ? await fetchAndExtract(reqEntry.fileUri, reqEntry.originalName || reqEntry.title) : "";

      // fetch/extract selected standard texts
      const standardsTexts = [];
      for (const sName of selectedStandards) {
        const uri = stdMap[sName]?.fileUri;
        if (!uri) continue;
        const txt = await fetchAndExtract(uri, sName);
        const short = sName.replace(/\.[^/.]+$/, "");
        standardsTexts.push({ name: short, text: txt });
      }

      // compose prompt parts (text blocks)
      const parts = [
        { text: baseInstruction },
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
      const jsonBlock = extractFirstJson(candidateText);
      if (jsonBlock) {
        try { parsed = JSON.parse(jsonBlock); } catch (e) { parsed = null; }
      }

      // retry once with an extremely strict short instruction if parsing failed
      if (!Array.isArray(parsed)) {
        const retryParts = [
          { text: "IMPORTANT: Return ONLY a JSON array and NOTHING ELSE. No text, no markdown. The array must contain objects with fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array)." },
          { text: `Requirement: ${reqId}\n${reqText}` },
          ...standardsTexts.map(s => ({ text: `Standard: ${s.name}\n\n${s.text || "<no text>"}\n` }))
        ];
        const retryResp = await ai.generate({ model, prompt: retryParts });
        const retryText = retryResp?.text || retryResp?.output || JSON.stringify(retryResp);
        // append retry to audit
        try { fs.appendFileSync(path.join(AI_RAW_DIR, `${reqId}-${Date.now()}-retry.log`), retryText); } catch (e) {}
        const retryBlock = extractFirstJson(retryText);
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
      const genId = `gen-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      const jiraId = ``;
      const savedEntry = { id: genId, requirementId: reqId, jiraId: jiraId, requirementTitle: reqEntry.title, selectedStandards, createdAt: new Date().toISOString(), testcases: normalized };
      generated.unshift(savedEntry);
      writeJson(GENERATED_DB, generated);

      results.push({ req_id: reqId, title: reqEntry.title, success: true, genId, count: normalized.length });
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
app.get("/generated", (req, res) => {
  const generated = readJson(GENERATED_DB, []);
  // return summary list
  const summary = generated.map(g => ({ id: g.id, requirementId: g.requirementId, jiraId: g.jiraId, requirementTitle: g.requirementTitle, createdAt: g.createdAt, count: (g.testcases || []).length }));
  res.json(summary);
});

/**
 * GET /generated/requirement/:reqId
 * Return testcases array for that requirement (latest generated set for requirement)
 */
app.get("/generated/requirement/:id", (req, res) => {
  const { id } = req.params;
  const generated = readJson(GENERATED_DB, []);
  // filter entries matching the requested requirement id
  const matches = generated.filter(g => String(g.id) === String(id));
  if (!matches || matches.length === 0) {
    return res.status(404).json({ error: "No generated testcases found for this requirement" });
  }
  // sort by createdAt descending (newest first). fallback to array order if createdAt missing.
  matches.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
  const entry = matches[0];
  return res.json({ id: entry.id, requirementId: entry.requirementId, jiraId: entry.jiraId, requirementTitle: entry.requirementTitle, testcases: entry.testcases });
});

/* ------------------ Regenerate single testcase (keeps tc_id) ------------------ */

/**
 * POST /testcases/:genId/regenerate/:tcId
 * Body optional: { promptOverride }
 * Replaces the single testcase object (must return single JSON object).
 */
app.post("/testcases/:genId/regenerate/:tcId", async (req, res) => {
  try {
    const { genId, tcId } = req.params;
    const { promptOverride } = req.body || {};
    const generated = readJson(GENERATED_DB, []);
    const genEntry = generated.find(g => g.id === genId);
    if (!genEntry) return res.status(404).json({ error: "Generated set not found" });

    const tcIndex = genEntry.testcases.findIndex(t => t.tc_id === tcId);
    if (tcIndex === -1) return res.status(404).json({ error: "Testcase id not found" });

    const reqMap = readJson(REQUIREMENTS_DB, {});
    const reqEntry = reqMap[genEntry.requirementId];
    if (!reqEntry) return res.status(404).json({ error: "Requirement not found" });

    const stdMap = readJson(STANDARDS_DB, {});
    const model = googleAI ? googleAI.model("gemini-2.5-flash") : "gemini-2.5-flash";

    const instruction = promptOverride && typeof promptOverride === "string"
      ? promptOverride
      : `Regenerate a single testcase JSON object (no extra text) with the exact fields: tc_id, req_id, jira_id (empty string), title, preconditions (array), steps (array), expected (string), automatable (boolean), suggested_tool (string), confidence (float 0-1), compliance (array). The tc_id must match the existing id: ${tcId}.`;

    const parts = [
      { text: instruction },
      { text: `Requirement id: ${reqEntry.id}\nTitle: ${reqEntry.title}` },
      { text: `Existing testcase: ${JSON.stringify(genEntry.testcases[tcIndex], null, 2)}` }
    ];

    // attach requirement and standards media where available
    if (reqEntry.fileUri) parts.push({ media: { contentType: "application/pdf", url: reqEntry.fileUri } });
    for (const s of genEntry.selectedStandards) {
      const uri = stdMap[s]?.fileUri;
      if (uri) parts.push({ media: { contentType: "application/pdf", url: uri } });
    }

    if (!ai) return res.status(500).json({ error: "AI client not initialized" });

    const genResp = await ai.generate({ model, prompt: parts });
    const candidateText =
      genResp?.text ||
      genResp?.output ||
      genResp?.candidates?.[0]?.content?.parts?.[0]?.text ||
      JSON.stringify(genResp);

    let parsed = null;
    try { parsed = JSON.parse(candidateText); } catch (e) { parsed = null; }

    if (!parsed || typeof parsed !== "object") {
      return res.status(500).json({ error: "AI did not return a valid JSON object for the testcase" });
    }

    // normalize and ensure tc_id preserved
    const newTc = {
      tc_id: parsed.tc_id || genEntry.testcases[tcIndex].tc_id,
      req_id: parsed.req_id || genEntry.requirementId,
      jira_id: parsed.jira_id || genEntry.jira_id,
      title: parsed.title || genEntry.testcases[tcIndex].title,
      preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions.map(String) : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
      expected: typeof parsed.expected === "string" ? parsed.expected : "",
      automatable: typeof parsed.automatable === "boolean" ? parsed.automatable : false,
      suggested_tool: typeof parsed.suggested_tool === "string" ? parsed.suggested_tool : "manual",
      confidence: Number.isFinite(parseFloat(parsed.confidence)) ? Math.max(0, Math.min(1, parseFloat(parsed.confidence))) : 0.0,
      compliance: Array.isArray(parsed.compliance) ? parsed.compliance.map(String) : []
    };

    // replace
    genEntry.testcases[tcIndex] = newTc;
    writeJson(GENERATED_DB, generated);

    res.json({ success: true, testcase: newTc });
  } catch (err) {
    console.error("regenerate single testcase error:", err);
    res.status(500).json({ error: "Regeneration failed", details: String(err) });
  }
});

/* ------------------ PATCH single testcase (manual update) ------------------ */

/**
 * PATCH /testcases/:genId/:tcId
 * body: fields to update (title, preconditions, steps, expected, automatable, suggested_tool, confidence, compliance)
 */
app.patch("/testcases/:genId/:tcId", (req, res) => {
  try {
    const { genId, tcId } = req.params;
    const updates = req.body || {};
    const generated = readJson(GENERATED_DB, []);
    const genEntry = generated.find(g => g.id === genId);
    if (!genEntry) return res.status(404).json({ error: "Generated set not found" });
    const idx = genEntry.testcases.findIndex(t => t.tc_id === tcId);
    if (idx === -1) return res.status(404).json({ error: "Testcase id not found" });

    const tc = genEntry.testcases[idx];
    if (updates.title) tc.title = updates.title;
    if (updates.preconditions) tc.preconditions = Array.isArray(updates.preconditions) ? updates.preconditions.map(String) : [String(updates.preconditions)];
    if (updates.steps) tc.steps = Array.isArray(updates.steps) ? updates.steps.map(String) : [String(updates.steps)];
    if (updates.expected) tc.expected = String(updates.expected);
    if (typeof updates.automatable === "boolean") tc.automatable = updates.automatable;
    if (updates.suggested_tool) tc.suggested_tool = String(updates.suggested_tool);
    if (typeof updates.confidence !== "undefined") {
      let c = parseFloat(updates.confidence);
      tc.confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : tc.confidence;
    }
    if (updates.compliance) tc.compliance = Array.isArray(updates.compliance) ? updates.compliance.map(String) : [String(updates.compliance)];

    writeJson(GENERATED_DB, generated);
    res.json({ success: true, testcase: tc });
  } catch (err) {
    console.error("patch testcase error:", err);
    res.status(500).json({ error: "Update failed", details: String(err) });
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
app.post("/testcases/:genId/:tcId/jira", async (req, res) => {
  try {
    const { genId, tcId } = req.params;
    const { issueType = "Task", assignee, projectKey } = req.body || {};

    if (!JIRA_BASE_URL || !JIRA_USER_EMAIL || !JIRA_API_TOKEN || !PROJ) {
      return res.status(400).json({ error: "Jira credentials/project not configured in env" });
    }

    const generated = readJson(GENERATED_DB, []);
    const genEntry = generated.find((g) => g.id === genId);
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

      // update all generated sets for same requirement to point to parentKey
      for (const g of generated) {
        if (g.requirementId === rqId) g.jiraId = parentKey;
      }
      // persist
      writeJson(GENERATED_DB, generated);
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

    // write changes
    writeJson(GENERATED_DB, generated);

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
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
