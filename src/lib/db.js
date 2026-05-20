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
      // Serverless cold starts need more time to reach Atlas; a small pool keeps
      // us under the free-tier connection cap across many function instances.
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 5,
    }).then((m) => {
      console.log("✅ MongoDB connected");
      return m;
    }).catch((err) => {
      // Reset the cached promise so the NEXT request retries instead of reusing
      // a permanently-rejected promise.
      globalCache._mongoose.promise = null;
      throw err;
    });
  }

  globalCache._mongoose.conn = await globalCache._mongoose.promise;
  return globalCache._mongoose.conn;
}
