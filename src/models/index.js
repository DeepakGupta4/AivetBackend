import mongoose from "mongoose";
const { Schema, model, models } = mongoose;

// ── User ──────────────────────────────────────────────────────────────────
const userSchema = new Schema({
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash:  { type: String },
  fullName:      { type: String, required: true },
  avatarUrl:     { type: String },
  oauthProvider: { type: String, index: true },
  oauthId:       { type: String, index: true },
  isVerified:    { type: Boolean, default: false, index: true },
  isActive:      { type: Boolean, default: true, index: true },
  lastLoginAt:   { type: Date },
}, { timestamps: true });

// Additional indexes for user queries (email uniqueness comes from the field above)
userSchema.index({ oauthProvider: 1, oauthId: 1 });
userSchema.index({ isActive: 1, isVerified: 1 });
userSchema.index({ createdAt: -1 });

// ── Team ──────────────────────────────────────────────────────────────────
const teamSchema = new Schema({
  name:    { type: String, required: true },
  slug:    { type: String, required: true, unique: true },
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  plan:    { type: String, enum: ["free","starter","pro","enterprise"], default: "free", index: true },
  members: [{ userId: { type: Schema.Types.ObjectId, ref: "User" }, role: { type: String, default: "member" }, joinedAt: Date }],
}, { timestamps: true });

// Additional indexes for team queries (slug uniqueness + ownerId come from the fields above)
teamSchema.index({ "members.userId": 1 });
teamSchema.index({ plan: 1, createdAt: -1 });

// ── Magic-Link Token ──────────────────────────────────────────────────────
const magicLinkTokenSchema = new Schema({
  email:     { type: String, required: true, lowercase: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date,   required: true },
  usedAt:    { type: Date },
  purpose:   { type: String, enum: ["login","signup"], default: "login" },
}, { timestamps: true });

// TTL and compound indexes (tokenHash uniqueness comes from the field above)
magicLinkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-delete
magicLinkTokenSchema.index({ email: 1, purpose: 1 });
magicLinkTokenSchema.index({ usedAt: 1 }, { sparse: true });

// ── Project ───────────────────────────────────────────────────────────────
const projectSchema = new Schema({
  teamId:       { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  name:         { type: String, required: true },
  domain:       { type: String, required: true },
  brandName:    { type: String, required: true },
  industry:     { type: String },
  targetRegion: { type: String, default: "global" },
  isActive:     { type: Boolean, default: true },
  competitors:  [{ domain: String, brandName: String, addedAt: { type: Date, default: Date.now } }],
}, { timestamps: true });

// ── Prompt Campaign ───────────────────────────────────────────────────────
const campaignSchema = new Schema({
  projectId:   { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
  name:        { type: String, required: true },
  description: { type: String },
  frequency:   { type: String, enum: ["hourly","daily","weekly"], default: "daily" },
  isActive:    { type: Boolean, default: true },
  nextRunAt:   { type: Date },
  prompts:     [{ text: String, category: String, intent: String, isActive: { type: Boolean, default: true } }],
}, { timestamps: true });

// ── Prompt Run ────────────────────────────────────────────────────────────
const promptRunSchema = new Schema({
  campaignId:   { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
  projectId:    { type: Schema.Types.ObjectId, ref: "Project",  required: true, index: true },
  promptText:   { type: String, required: true, index: true },
  status:       { type: String, enum: ["pending","running","completed","failed"], default: "pending", index: true },
  startedAt:    { type: Date, index: true },
  completedAt:  { type: Date, index: true },
  errorMessage: { type: String },
  responses: [{
    model:        String,
    provider:     String,
    responseText: String,
    tokensUsed:   Number,
    latencyMs:    Number,
    mentions: [{
      entityName:     String,
      entityType:     String,
      mentionCount:   Number,
      rankPosition:   Number,
      sentiment:      String,
      sentimentScore: Number,
      confidence:     Number,
      contextSnippet: String,
    }],
    citations: [{
      citedUrl:       String,
      citedDomain:    String,
      isBrandDomain:  Boolean,
      authorityScore: Number,
    }],
  }],
}, { timestamps: true });

// Performance indexes for prompt runs
promptRunSchema.index({ campaignId: 1, status: 1 });
promptRunSchema.index({ projectId: 1, status: 1, createdAt: -1 });
promptRunSchema.index({ status: 1, createdAt: -1 });
promptRunSchema.index({ completedAt: -1 }, { sparse: true });
promptRunSchema.index({ projectId: 1, completedAt: -1 });

// ── Visibility Score ──────────────────────────────────────────────────────
const visibilityScoreSchema = new Schema({
  projectId:       { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
  scoreDate:       { type: String, required: true },   // "YYYY-MM-DD"
  overallScore:    { type: Number, required: true },
  mentionScore:    { type: Number },
  rankingScore:    { type: Number },
  sentimentScore:  { type: Number },
  citationScore:   { type: Number },
  diversityScore:  { type: Number },
  totalPrompts:    { type: Number, default: 0 },
  totalMentions:   { type: Number, default: 0 },
  modelsBreakdown: { type: Map, of: Number },
}, { timestamps: true });
visibilityScoreSchema.index({ projectId: 1, scoreDate: 1 }, { unique: true });
// Performance indexes for visibility scores
visibilityScoreSchema.index({ projectId: 1, scoreDate: -1 });
visibilityScoreSchema.index({ scoreDate: -1 });
visibilityScoreSchema.index({ overallScore: -1 });
visibilityScoreSchema.index({ projectId: 1, createdAt: -1 });

// ── Subscription ──────────────────────────────────────────────────────────
const subscriptionSchema = new Schema({
  teamId:           { type: Schema.Types.ObjectId, ref: "Team", unique: true, required: true },
  stripeCustomerId: { type: String, index: true },
  stripeSubId:      { type: String, index: true },
  plan:             { type: String, enum: ["free","starter","pro","enterprise"], default: "free" },
  status:           { type: String, enum: ["active","trialing","past_due","canceled","incomplete"], default: "active" },
  currentPeriodEnd: { type: Date },
  cancelAtPeriodEnd:{ type: Boolean, default: false },
  promptLimit:      { type: Number, default: 100 },
  projectLimit:     { type: Number, default: 1 },
}, { timestamps: true });

// ── Audit Log ─────────────────────────────────────────────────────────────
const auditLogSchema = new Schema({
  userId:   { type: Schema.Types.ObjectId, ref: "User",  index: true },
  teamId:   { type: Schema.Types.ObjectId, ref: "Team",  index: true },
  action:   { type: String, required: true, index: true },
  resource: { type: String },
  metadata: { type: Schema.Types.Mixed },
  ipAddress:{ type: String },
}, { timestamps: true });

// ── Domain Authority cache (DataForSEO Labs traffic → 0-100) ───────────────
const domainAuthoritySchema = new Schema({
  domain:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  authority: { type: Number, default: 0 },
  etv:       { type: Number, default: 0 },
}, { timestamps: true });

export const User             = models.User             || model("User",            userSchema);
export const DomainAuthority  = models.DomainAuthority  || model("DomainAuthority", domainAuthoritySchema);
export const Team             = models.Team             || model("Team",            teamSchema);
export const MagicLinkToken   = models.MagicLinkToken   || model("MagicLinkToken",  magicLinkTokenSchema);
export const Project          = models.Project          || model("Project",         projectSchema);
export const Campaign         = models.Campaign         || model("Campaign",        campaignSchema);
export const PromptRun        = models.PromptRun        || model("PromptRun",       promptRunSchema);
export const VisibilityScore  = models.VisibilityScore  || model("VisibilityScore", visibilityScoreSchema);
export const Subscription     = models.Subscription     || model("Subscription",    subscriptionSchema);
export const AuditLog         = models.AuditLog         || model("AuditLog",        auditLogSchema);
