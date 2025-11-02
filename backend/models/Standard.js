const mongoose = require("mongoose");

const standardSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    filename: { type: String, required: true },
    fileUri: { type: String },
    uploadedAt: { type: Date, default: () => new Date() },
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

standardSchema.index({ user: 1, filename: 1 }, { unique: true });

module.exports = mongoose.models.Standard || mongoose.model("Standard", standardSchema);



