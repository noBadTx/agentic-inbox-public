// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Provider-switchable email sending for agentic-inbox.
 *
 * Priority: Resend (free tier, uses RESEND_API_KEY secret) → CF send_email binding.
 * Header-based metadata (threading, loop markers) is passed to Resend as
 * RFC 5322 headers so replies thread correctly in users' mail clients.
 *
 * Sender identity rules (deliberate):
 *   - from = the mailbox address, optionally with a display name
 *   - replyTo is NEVER set: user replies go straight back to support@domain
 */

import { sendEmail as cfSendEmail } from "../email-sender";

export interface UnifiedSendParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	headers?: Record<string, string>;
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
}

function formatFrom(
	from: string | { email: string; name: string },
): string {
	if (typeof from === "string") return from;
	const email = from.email;
	const name = from.name?.trim();
	if (!name) return email;
	// RFC 5322 display name; strip chars that could break the header
	const safeName = name.replace(/["<>\r\n]/g, "").trim();
	return `"${safeName}" <${email}>`;
}

function formatAddr(a: string | { email: string; name: string }): string {
	if (typeof a === "string") return a;
	return a.email;
}

async function sendViaResend(
	apiKey: string,
	params: UnifiedSendParams,
): Promise<{ messageId: string; provider: "resend" }> {
	const body: Record<string, unknown> = {
		from: formatFrom(params.from),
		to: Array.isArray(params.to) ? params.to : [params.to],
		subject: params.subject,
	};
	if (params.html) body.html = params.html;
	if (params.text) body.text = params.text;
	if (params.cc) body.cc = Array.isArray(params.cc) ? params.cc : [params.cc];
	if (params.bcc) body.bcc = Array.isArray(params.bcc) ? params.bcc : [params.bcc];
	// Keep the visible Sender aligned with From. Some receiving clients
	// otherwise synthesize Sender from the provider's bounce address.
	const headers = Object.fromEntries(
		Object.entries(params.headers ?? {}).filter(([name]) => name.toLowerCase() !== "sender"),
	);
	body.headers = { ...headers, Sender: formatFrom(params.from) };
	if (params.attachments && params.attachments.length > 0) {
		body.attachments = params.attachments.map((a) => ({
			filename: a.filename,
			content: a.content,
			content_type: a.type,
			content_id: a.contentId,
		}));
	}

	const resp = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text().catch(() => "");
		throw new Error(`Resend send failed (${resp.status}): ${errText.slice(0, 300)}`);
	}
	const data = (await resp.json()) as { id?: string };
	return { messageId: data.id || "resend-no-id", provider: "resend" };
}

async function sendViaCF(
	binding: SendEmail,
	params: UnifiedSendParams,
): Promise<{ messageId: string; provider: "cf" }> {
	const result = await cfSendEmail(binding, {
		to: params.to,
		from: params.from,
		subject: params.subject,
		html: params.html,
		text: params.text,
		cc: params.cc,
		bcc: params.bcc,
		// NOTE: replyTo intentionally never set — replies go to support@
		attachments: params.attachments,
		headers: params.headers,
	});
	return { messageId: result.messageId, provider: "cf" };
}

/**
 * Multi-account Resend support: RESEND_API_KEYS (comma-separated) allows
 * several Resend accounts, each with its own verified domains (Resend free
 * tier allows only 3 domains per account). The key whose account has the
 * sending domain verified is chosen per send; key selection state is kept
 * in module scope per isolate (last-known-good wins, failures rotate).
 *
 * Resolution order per send:
 *   1. env.RESEND_DOMAIN_KEY_MAP (JSON: {"domain.com": "re_xxx", ...}) —
 *      explicit per-domain key assignment, highest priority
 *   2. last key that successfully sent for this from-domain (isolate cache)
 *   3. keys in order: first success wins (Resend rejects unverified domains
 *      with 403/422, which advances the rotation)
 * Falls back to CF send_email binding if all keys fail.
 */

/** Isolate-level cache: from-domain → last successful API key. */
const domainKeyCache = new Map<string, string>();

function parseKeys(env: { RESEND_API_KEY?: string; RESEND_API_KEYS?: string }): string[] {
	const multi = (env.RESEND_API_KEYS || "")
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	if (multi.length > 0) return multi;
	return env.RESEND_API_KEY ? [env.RESEND_API_KEY] : [];
}

function parseDomainKeyMap(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [domain, key] of Object.entries(parsed)) {
			if (typeof key === "string" && key.startsWith("re_")) {
				out[domain.trim().toLowerCase()] = key;
			}
		}
		return out;
	} catch {
		console.warn("RESEND_DOMAIN_KEY_MAP is not valid JSON — ignoring");
		return {};
	}
}

/** Pick the candidate keys for a from-domain, best first. */
function candidateKeys(
	env: { RESEND_API_KEY?: string; RESEND_API_KEYS?: string; RESEND_DOMAIN_KEY_MAP?: string },
	fromDomain: string,
): string[] {
	const all = parseKeys(env);
	if (all.length === 0) return [];
	const map = parseDomainKeyMap(env.RESEND_DOMAIN_KEY_MAP);
	const pinned = map[fromDomain];

	const ordered: string[] = [];
	if (pinned && all.includes(pinned)) ordered.push(pinned);
	const cached = domainKeyCache.get(fromDomain);
	if (cached && all.includes(cached) && !ordered.includes(cached)) ordered.push(cached);
	for (const k of all) if (!ordered.includes(k)) ordered.push(k);
	return ordered;
}
export async function sendUnified(
	env: {
		EMAIL?: SendEmail;
		RESEND_API_KEY?: string;
		RESEND_API_KEYS?: string;
		RESEND_DOMAIN_KEY_MAP?: string;
	},
	params: UnifiedSendParams,
): Promise<{ messageId: string; provider: "resend" | "cf" }> {
	const fromEmail = typeof params.from === "string" ? params.from : params.from.email;
	const fromDomain = fromEmail.split("@")[1]?.toLowerCase() || "";

	const keys = candidateKeys(env, fromDomain);
	if (keys.length > 0) {
		const errors: string[] = [];
		for (const key of keys) {
			try {
				const result = await sendViaResend(key, params);
				// Remember the working key for this domain (per-isolate).
				if (fromDomain) domainKeyCache.set(fromDomain, key);
				return result;
			} catch (e) {
				errors.push((e as Error).message);
			}
		}
		// All Resend keys failed — fall back to CF binding if available.
		if (env.EMAIL) {
			console.warn(
				`All ${keys.length} Resend key(s) failed for ${fromEmail}, falling back to CF binding:`,
				errors.join(" | "),
			);
			return sendViaCF(env.EMAIL, params);
		}
		throw new Error(`All ${keys.length} Resend key(s) failed: ${errors.join(" | ")}`);
	}
	if (env.EMAIL) {
		return sendViaCF(env.EMAIL, params);
	}
	throw new Error("No email provider configured (RESEND_API_KEYS or EMAIL binding)");
}
