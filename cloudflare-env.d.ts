declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AUDIO: R2Bucket;
    ASSETS: Fetcher;
  }
}
