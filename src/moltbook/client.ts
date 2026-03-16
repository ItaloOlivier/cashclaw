const BASE_URL = "https://www.moltbook.com/api/v1";
const API_KEY = process.env.MOLTBOOK_API_KEY ?? "";
const REQUEST_TIMEOUT = 15_000;

interface MoltbookResponse<T = unknown> {
  success: boolean;
  error?: string;
  hint?: string;
  data?: T;
  [key: string]: unknown;
}

interface VerificationChallenge {
  verification_code: string;
  challenge_text: string;
  expires_at: string;
  instructions: string;
}

async function moltbookFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<MoltbookResponse<T> & Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
  };
  if (opts.body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  const json = (await res.json()) as MoltbookResponse<T> & Record<string, unknown>;
  if (!res.ok && !json.verification) {
    throw new Error(json.error ?? json.message as string ?? `Moltbook ${res.status}`);
  }
  return json;
}

/** Solve a verification challenge (math word problem) */
function solveChallenge(text: string): string {
  // Extract numbers and operations from the challenge text
  const numbers = text.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 2) return "0.00";

  // Common patterns: addition, subtraction, multiplication
  const lower = text.toLowerCase();
  let result: number;
  if (lower.includes("sum") || lower.includes("add") || lower.includes("plus") || lower.includes("total") || lower.includes("combined")) {
    result = numbers.reduce((a, b) => a + b, 0);
  } else if (lower.includes("difference") || lower.includes("subtract") || lower.includes("minus") || lower.includes("less")) {
    result = numbers[0] - numbers.slice(1).reduce((a, b) => a + b, 0);
  } else if (lower.includes("product") || lower.includes("multipl") || lower.includes("times")) {
    result = numbers.reduce((a, b) => a * b, 1);
  } else if (lower.includes("divide") || lower.includes("quotient") || lower.includes("ratio")) {
    result = numbers.length >= 2 ? numbers[0] / numbers[1] : 0;
  } else {
    // Default: try addition
    result = numbers.reduce((a, b) => a + b, 0);
  }
  return result.toFixed(2);
}

/** Submit a verification answer */
async function submitVerification(
  verificationCode: string,
  answer: string,
): Promise<MoltbookResponse> {
  return moltbookFetch("/verify", {
    method: "POST",
    body: { verification_code: verificationCode, answer },
  });
}

/** Handle verification challenge if present in response */
async function handleVerification(
  response: MoltbookResponse & Record<string, unknown>,
): Promise<string | null> {
  const v = response.verification as VerificationChallenge | undefined;
  if (!v) return null;

  const answer = solveChallenge(v.challenge_text);
  const result = await submitVerification(v.verification_code, answer);
  if (result.success) {
    return (result as Record<string, unknown>).content_id as string ?? "verified";
  }
  throw new Error(`Verification failed: ${result.error ?? "unknown"}`);
}

// ── Public API ──

export async function getHome(): Promise<Record<string, unknown>> {
  const res = await moltbookFetch("/home");
  return res;
}

export async function getFeed(
  sort: "hot" | "new" | "top" | "rising" = "hot",
  limit = 25,
): Promise<Record<string, unknown>> {
  return moltbookFetch(`/posts?sort=${sort}&limit=${limit}`);
}

export async function getSubmoltFeed(
  submolt: string,
  sort: "hot" | "new" | "top" = "hot",
  limit = 25,
): Promise<Record<string, unknown>> {
  return moltbookFetch(`/submolts/${encodeURIComponent(submolt)}/feed?sort=${sort}&limit=${limit}`);
}

export async function createPost(
  submoltName: string,
  title: string,
  content?: string,
  url?: string,
): Promise<string> {
  const body: Record<string, string> = { submolt_name: submoltName, title };
  if (content) body.content = content;
  if (url) body.url = url;
  if (url) body.type = "link";

  const res = await moltbookFetch("/posts", { method: "POST", body });
  const contentId = await handleVerification(res);
  if (contentId) return contentId;
  return (res as Record<string, unknown>).post_id as string ?? "posted";
}

export async function createComment(
  postId: string,
  content: string,
  parentId?: string,
): Promise<string> {
  const body: Record<string, string> = { content };
  if (parentId) body.parent_id = parentId;

  const res = await moltbookFetch(`/posts/${postId}/comments`, { method: "POST", body });
  const contentId = await handleVerification(res);
  if (contentId) return contentId;
  return (res as Record<string, unknown>).comment_id as string ?? "commented";
}

export async function upvotePost(postId: string): Promise<void> {
  await moltbookFetch(`/posts/${postId}/upvote`, { method: "POST" });
}

export async function search(
  query: string,
  type: "posts" | "comments" | "all" = "all",
  limit = 20,
): Promise<Record<string, unknown>> {
  return moltbookFetch(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
}

export async function listSubmolts(): Promise<Record<string, unknown>> {
  return moltbookFetch("/submolts");
}

export async function getProfile(): Promise<Record<string, unknown>> {
  return moltbookFetch("/agents/me");
}

export function isMoltbookAvailable(): boolean {
  return Boolean(process.env.MOLTBOOK_API_KEY);
}
