// Admin script — reset a user's team + subscription back to the free tier.
// Usage:  node src/scripts/reset-user-plan.js <email> [targetPlan]
// targetPlan defaults to "free". Valid: free | starter | pro | enterprise.

import "dotenv/config";
import { connectDB } from "../lib/db.js";
import { User, Team, Subscription } from "../models/index.js";
import mongoose from "mongoose";

const VALID_PLANS = ["free", "starter", "pro", "enterprise"];

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  const targetPlan = (process.argv[3] || "free").toLowerCase();

  if (!email) {
    console.error("Usage: node src/scripts/reset-user-plan.js <email> [targetPlan]");
    process.exit(1);
  }
  if (!VALID_PLANS.includes(targetPlan)) {
    console.error(`Invalid plan "${targetPlan}". Use one of: ${VALID_PLANS.join(", ")}`);
    process.exit(1);
  }

  await connectDB();

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(2);
  }

  const team = await Team.findOne({ "members.userId": user._id });
  if (!team) {
    console.error(`User ${email} has no team`);
    process.exit(3);
  }

  const beforeTeam = team.plan;
  team.plan = targetPlan;
  await team.save();

  const sub = await Subscription.findOne({ teamId: team._id });
  const beforeSub = sub?.plan ?? "(no subscription doc)";

  if (sub) {
    sub.plan = targetPlan;
    sub.status = targetPlan === "free" ? "canceled" : "active";
    if (targetPlan === "free") {
      sub.cancelAtPeriodEnd = false;
      sub.currentPeriodEnd = null;
    }
    await sub.save();
  } else if (targetPlan !== "free") {
    await Subscription.create({ teamId: team._id, plan: targetPlan, status: "active" });
  }

  console.log("✅ Plan reset complete");
  console.log({
    email,
    teamId: team._id.toString(),
    teamSlug: team.slug,
    teamPlan:         { before: beforeTeam, after: targetPlan },
    subscriptionPlan: { before: beforeSub, after: targetPlan },
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(99);
});
