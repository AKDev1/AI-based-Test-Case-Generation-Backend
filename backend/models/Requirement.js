const mongoose = require("mongoose");

const requirementSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reqId: { type: String, required: true },
    title: { type: String, required: true },
    originalName: { type: String },
    fileUri: { type: String },
    uploadedAt: { type: Date, default: () => new Date() },
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

requirementSchema.index({ user: 1, reqId: 1 }, { unique: true });

module.exports = mongoose.models.Requirement || mongoose.model("Requirement", requirementSchema);



