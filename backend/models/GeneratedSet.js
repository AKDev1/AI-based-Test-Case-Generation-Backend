const mongoose = require("mongoose");

const testcaseSchema = new mongoose.Schema(
  {
    tc_id: { type: String, required: true },
    req_id: { type: String, required: true },
    jira_id: { type: String, default: "" },
    title: { type: String, required: true },
    preconditions: { type: [String], default: [] },
    steps: { type: [String], default: [] },
    expected: { type: String, default: "" },
    automatable: { type: Boolean, default: false },
    suggested_tool: { type: String, default: "manual" },
    confidence: { type: Number, default: 0 },
    compliance: { type: [String], default: [] },
  },
  { _id: false }
);

const generatedSetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requirement: { type: mongoose.Schema.Types.ObjectId, ref: "Requirement" },
    requirementId: { type: String, required: true },
    requirementTitle: { type: String },
    jiraId: { type: String, default: "" },
    selectedStandards: { type: [String], default: [] },
    testcases: { type: [testcaseSchema], default: [] },
    promptOverride: { type: String },
  },
  {
    timestamps: true,
  }
);

generatedSetSchema.index({ user: 1, requirementId: 1, createdAt: -1 });

module.exports =
  mongoose.models.GeneratedSet || mongoose.model("GeneratedSet", generatedSetSchema);






