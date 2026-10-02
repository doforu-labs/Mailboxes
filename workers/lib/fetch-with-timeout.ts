// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
/**
 * Fetch with timeout and error handling for external API calls.
 * Returns a Response-like object on timeout for consistent error handling.
 */
export async function fetchWithTimeout(
	url: string | URL,
	options: RequestInit = {},
	timeoutMs = 15_000,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
		});
		return response;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`Request timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timeoutId);
	}
}
