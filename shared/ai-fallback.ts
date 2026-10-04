// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Stable, machine-readable sentinel for the AI fallback reply.
 *
 * ── Why a sentinel and not the translated string? ───────────────────────────
 * When the model returns no output the server replies with a generic
 * "I couldn't find anything relevant" message. That message is persisted to D1
 * as an assistant chat message and replayed on every later session — so
 * persisting the *translated* text would freeze the language it was generated in
 * and read as mixed-language after a language switch (see the ⚠️  note on
 * `saveAiMessage` in `workers/db/index.ts` and in `shared/i18n/resources.ts`).
 *
 * Convention: persist stable data, translate at the edge for display.
 *   • Streaming / immediate response → localized text (`api:aiNoRelevantInfo`),
 *     so the current session keeps its immediate experience.
 *   • What goes to D1                → this sentinel.
 *   • Rendering history (AiPanel)    → map the sentinel back to localized text
 *     (`aiPanel:fallbackNoInfo`) in the *current* UI language.
 *
 * The value is deliberately ugly and namespaced so it cannot collide with real
 * model output. Treat it as a wire/storage constant: changing it would orphan
 * already-persisted rows, so don't.
 */
export const AI_FALLBACK_SENTINEL = "__i18n_fallback_no_info__";

/** Type guard for the persisted AI fallback marker (narrows to the exact literal). */
export function isAiFallbackSentinel(value: string): value is typeof AI_FALLBACK_SENTINEL {
	return value === AI_FALLBACK_SENTINEL;
}
