import mongoose from "mongoose";

// Cache on the globalThis object so it survives across serverless invocations
// in the same Node.js worker (Vercel reuses workers for warm requests).
const globalCache = globalThis;
globalCache._mongoose ??= { conn: null, promise: null };

export async function connectDB() {
  if (globalCache._mongoose.conn) return globalCache._mongoose.conn;

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set");
  }

  if (!globalCache._mongoose.promise) {
    globalCache._mongoose.promise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    }).then((m) => {
      console.log("✅ MongoDB connected");
      return m;
    });
  }

  globalCache._mongoose.conn = await globalCache._mongoose.promise;
  return globalCache._mongoose.conn;
}
