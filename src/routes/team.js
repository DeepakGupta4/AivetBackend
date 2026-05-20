import { Router } from "express";
import { Team, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// GET /api/team — current user's team + members
router.get("/", async (req, res) => {
  try {
    const team = await Team.findOne({ "members.userId": req.user._id }).lean();
    if (!team) return res.status(404).json({ success: false, message: "No team found" });

    const userIds = team.members.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds } }).select("fullName email avatarUrl").lean();
    const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

    const members = team.members.map((m) => ({
      userId:   m.userId,
      role:     m.role,
      joinedAt: m.joinedAt,
      fullName: byId[m.userId.toString()]?.fullName ?? "—",
      email:    byId[m.userId.toString()]?.email ?? "",
    }));

    res.json({ success: true, data: { id: team._id, name: team.name, slug: team.slug, plan: team.plan, members } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
