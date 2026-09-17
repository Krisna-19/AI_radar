/*
 * AI RADAR - HTTP fetch with classified errors (Node pipeline).
 *
 * Error classification drives graceful failure handling and per-source stats:
 *   - "timeout": response did not arrive within timeoutMs (AbortController)
 *   - "http":    non-2xx response status
 *   - "network": DNS / connection / socket-level failure
 *   - "empty":   successful status but no body content
 *
 * Uses the global fetch (Node 18+). No third-party dependencies.
 */

"use strict";

class FeedError extends Error {
  constructor(type, message) {
    super(message || type);
    this.name = "FeedError";
    this.type = type;
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

function defaultHeaders() {
  return {
    "User-Agent":
      process.env.HTTP_USER_AGENT ||
      "Mozilla/5.0 (compatible; AIRadarBot/1.0; +https://krisna-19.github.io/AI_radar/)",
    Accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    "Accept-Encoding": "identity",
  };
}

async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: Object.assign({}, defaultHeaders(), opts.headers || {}),
    });
    if (!resp.ok) throw new FeedError("http", "HTTP " + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = buf.toString("utf8");
    if (!text.trim()) throw new FeedError("empty", "Empty response body");
    return { text, responseMs: Date.now() - started, status: resp.status };
  } catch (e) {
    if (e.name === "AbortError") {
      throw new FeedError("timeout", "Timeout after " + timeoutMs + "ms");
    }
    if (e instanceof FeedError) throw e;
    const cause =
      (e && e.cause && (e.cause.message || String(e.cause))) ||
      (e && e.message) ||
      String(e);
    throw new FeedError("network", String(cause));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL and read the response body with a byte-cap.
 * Enforces maxBytes WHILE reading (chunk-by-chunk), not after full buffering.
 * Returns { text, contentType, responseMs, status }.
 * Throws FeedError on timeout, HTTP error, network failure, or empty body.
 */
async function fetchBytes(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes =
    typeof opts.maxBytes === "number" && opts.maxBytes > 0 ? opts.maxBytes : Infinity;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: Object.assign({}, defaultHeaders(), opts.headers || {}),
    });
    if (!resp.ok) throw new FeedError("http", "HTTP " + resp.status);

    const contentType = (resp.headers && resp.headers.get("content-type")) || "";
    const reader = resp.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    let limitExceeded = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        limitExceeded = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
    }

    if (limitExceeded) {
      throw new FeedError(
        "http",
        "Response exceeded " + maxBytes + " byte limit"
      );
    }

    const buf = Buffer.concat(chunks);
    const text = buf.toString("utf8");
    if (!text.trim()) throw new FeedError("empty", "Empty response body");
    return {
      text,
      contentType,
      responseMs: Date.now() - started,
      status: resp.status,
    };
  } catch (e) {
    if (e.name === "AbortError") {
      throw new FeedError("timeout", "Timeout after " + timeoutMs + "ms");
    }
    if (e instanceof FeedError) throw e;
    const cause =
      (e && e.cause && (e.cause.message || String(e.cause))) ||
      (e && e.message) ||
      String(e);
    throw new FeedError("network", String(cause));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchText, fetchBytes, FeedError, DEFAULT_TIMEOUT_MS };