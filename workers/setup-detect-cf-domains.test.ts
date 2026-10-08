// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression guards for `POST /api/v1/setup/detect-cf-domains`.
 *
 * WHY these cases exist — the misleading-error incident.
 *
 * The settings page ("Platform Settings → Cloudflare API credentials") used to
 * report ANY verification failure as "the provided Cloudflare API Token or
 * Account ID is invalid". That text is a GUESS about the cause, not a report
 * of the cause, and it was wrong for the failure users actually hit: a token
 * whose **Client IP Address Filtering** allows only the operator's own IP.
 * The Worker calls `api.cloudflare.com` from Cloudflare's own egress
 * addresses, so such a token works perfectly from `curl` on the operator's
 * machine while every request the app makes is rejected — and the UI blamed
 * the credentials, sending the operator to re-check a token that was fine.
 *
 * The route now forwards Cloudflare's own `errors[0].message` PLUS the
 * upstream HTTP status and error code, so the client can say what actually
 * happened. These cases pin that contract:
 *
 *   - a non-2xx upstream response forwards `message` / `status` / `code`;
 *   - an HTTP 200 response that still carries `success: false` does too
 *     (Cloudflare mixes both shapes, so only the `!ok` branch is not enough);
 *   - an unparsable upstream body degrades to the localized `cfApiError`
 *     string while STILL reporting the upstream status, and does not invent
 *     an error code;
 *   - the success path is untouched and does NOT leak the new fields.
 *
 * Reverse verification (MEASURED, not assumed): reverting the `!res.ok`
 * branch to `return c.json({ error: msg }, 400)` — dropping `cfStatus` /
 * `cfCode` — turns cases 1 and 3 RED (`cfStatus` reads `undefined`), but
 * leaves case 2 GREEN, because case 2 exercises the separate `!data.success`
 * branch. Reverting THAT branch to the same single-field shape is what turns
 * case 2 RED. The success case stays green either way, as it must.
 *
 * No test here performs a real HTTP request: the route's only network call
 * goes through `./lib/fetch-with-timeout`, which is stubbed below.
 *
 * To run: npm test
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Hono } from "hono";

// ── Cloudflare API stub ─────────────────────────────────────────────
//
// `fetchWithTimeout` is the single network call on this route's path, so
// replacing the module keeps the suite deterministic and offline.
//
// As in `setup-domain-checks.test.ts`: this must be a `mock.fn` whose
// implementation is REASSIGNED per case. `mock.module` snapshots its options
// bag at registration time, so a closure reading a later-reassigned
// module-level binding would keep serving the value captured at import.
let nextUpstream: () => Response = () => {
	throw new Error("nextUpstream was not scripted for this case");
};

const mockFetchWithTimeout = mock.fn(
	async (_url: string | URL, _options: RequestInit = {}): Promise<Response> =>
		nextUpstream(),
);

mock.module("./lib/fetch-with-timeout", {
	namedExports: { fetchWithTimeout: mockFetchWithTimeout },
});

// Imported AFTER the module mock so the route binds the stub.
const { default: setup } = await import("./setup");

// A standalone Hono mount. Both credentials are supplied in the request body,
// so the D1 fallback lookup is never reached and no `env` shim is needed.
const app = new Hono();
app.route("/", setup);

/**
 * A Cloudflare v4 error envelope. `status` is the HTTP status the upstream
 * response carries — NOT always non-2xx: Cloudflare also returns `200` with
 * `success: false`, which is why the route checks both.
 */
function cfErrorEnvelope(status: number, code: number, message: string): Response {
	return Response.json({ success: false, errors: [{ code, message }] }, { status });
}

async function postDetect(): Promise<{
	status: number;
	body: Record<string, unknown>;
}> {
	const res = await app.request("/api/v1/setup/detect-cf-domains", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			cfApiToken: "cfat_placeholder",
			cfAccountId: "3ec5438f9e30e232506d2e2e3e0f1745",
		}),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── Failure path: the upstream reason must survive ──────────────────

describe("detect-cf-domains forwards the upstream failure verbatim", () => {
	it("forwards Cloudflare's message, status and error code", async () => {
		// Stand-in for the reject an IP-filtered token gets when the WORKER
		// calls the API. The assertion is about the PASS-THROUGH, so the exact
		// status/code Cloudflare picks is deliberately not assumed here.
		nextUpstream = () => cfErrorEnvelope(403, 9109, "Invalid API Token");
		const { status, body } = await postDetect();

		assert.equal(status, 400);
		assert.equal(body.error, "Invalid API Token");
		assert.equal(body.cfStatus, 403, "upstream status must reach the client");
		assert.equal(body.cfCode, 9109, "Cloudflare error code must reach the client");
	});

	it("forwards an HTTP 200 envelope that still says success:false", async () => {
		nextUpstream = () => cfErrorEnvelope(200, 10000, "Authentication error");
		const { status, body } = await postDetect();

		assert.equal(status, 400);
		assert.equal(body.error, "Authentication error");
		assert.equal(body.cfStatus, 200);
		assert.equal(body.cfCode, 10000);
	});

	it("keeps the upstream status and invents no code when the body is not JSON", async () => {
		nextUpstream = () => new Response("<html>bad gateway</html>", { status: 502 });
		const { status, body } = await postDetect();

		assert.equal(status, 400);
		// Exact wording is locale-dependent (apiSetup.json); the status is not.
		assert.equal(typeof body.error, "string");
		assert.match(body.error as string, /502/);
		assert.equal(body.cfStatus, 502);
		assert.equal(body.cfCode, undefined, "a missing code must stay undefined");
	});
});

// ── Success path: no regression, no new fields ──────────────────────

describe("detect-cf-domains success path is unchanged", () => {
	it("returns the zones and does not leak the upstream-status fields", async () => {
		nextUpstream = () =>
			Response.json({
				success: true,
				errors: [],
				result: [
					{
						id: "zone-1",
						name: "doforu.app",
						status: "active",
						account: { id: "acct", name: "Doforu" },
					},
					{ id: "zone-2", name: "doforu.ai", status: "active" },
				],
				result_info: { total_pages: 1 },
			});

		const { status, body } = await postDetect();

		assert.equal(status, 200);
		assert.deepEqual(body.zones, [
			{ id: "zone-1", name: "doforu.app", status: "active" },
			{ id: "zone-2", name: "doforu.ai", status: "active" },
		]);
		assert.equal(body.accountName, "Doforu");
		assert.equal("cfStatus" in body, false);
		assert.equal("cfCode" in body, false);
	});
});
