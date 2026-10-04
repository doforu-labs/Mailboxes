// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Translation catalogs, aggregated into the shape i18next expects:
 *
 *   resources[locale][namespace] = { key: "value", ... }
 *
 * ── Adding keys from a feature chunk ────────────────────────────────────────
 * 1. Pick (or add) a namespace for your area, e.g. `domain`.
 * 2. Add the key to BOTH `locales/en/<ns>.json` and `locales/zh/<ns>.json`.
 * 3. Import both JSON files below and wire them into `resources.en` /
 *    `resources.zh` (they are static imports so Vite + Workers can bundle
 *    them without a dynamic-import fetch).
 *
 * Never add a key to one locale only — `en` is the fallback catalog, so a
 * missing English key would surface the raw key string in the UI.
 *
 * ⚠️  Do NOT persist translated strings to D1. AI chat history is stored and
 * replayed across sessions (see `saveAiMessage` in `workers/db/index.ts`);
 * storing a localized string there would freeze the language it was generated
 * in. Persist stable data (user input, enum values, ids) and translate at the
 * edge for display. See `shared/i18n/translate.ts` for the full convention.
 */

import type { Locale } from "./types";

// English catalogs
import enCommon from "./locales/en/common.json";
import enLayout from "./locales/en/layout.json";
import enDashboard from "./locales/en/dashboard.json";
import enDomain from "./locales/en/domain.json";
import enDomainDetails from "./locales/en/domainDetails.json";
import enEditor from "./locales/en/editor.json";
import enAiPanel from "./locales/en/aiPanel.json";
import enCompose from "./locales/en/compose.json";
import enMailPanel from "./locales/en/mailPanel.json";
import enMail from "./locales/en/mail.json";
import enSettings from "./locales/en/settings.json";
import enAuth from "./locales/en/auth.json";
import enApi from "./locales/en/api.json";
import enApiSetup from "./locales/en/apiSetup.json";
import enApiTool from "./locales/en/apiTool.json";
import enApiAuth from "./locales/en/apiAuth.json";

// Chinese catalogs
import zhCommon from "./locales/zh/common.json";
import zhLayout from "./locales/zh/layout.json";
import zhDashboard from "./locales/zh/dashboard.json";
import zhDomain from "./locales/zh/domain.json";
import zhDomainDetails from "./locales/zh/domainDetails.json";
import zhEditor from "./locales/zh/editor.json";
import zhAiPanel from "./locales/zh/aiPanel.json";
import zhCompose from "./locales/zh/compose.json";
import zhMailPanel from "./locales/zh/mailPanel.json";
import zhMail from "./locales/zh/mail.json";
import zhSettings from "./locales/zh/settings.json";
import zhAuth from "./locales/zh/auth.json";
import zhApi from "./locales/zh/api.json";
import zhApiSetup from "./locales/zh/apiSetup.json";
import zhApiTool from "./locales/zh/apiTool.json";
import zhApiAuth from "./locales/zh/apiAuth.json";

/**
 * Namespaces that exist in the app. Add a namespace here only after creating
 * both `locales/en/<ns>.json` and `locales/zh/<ns>.json`.
 */
export const NAMESPACES = [
	"common",
	"layout",
	"dashboard",
	"domain",
	"domainDetails",
	"editor",
	"aiPanel",
	"compose",
	"mailPanel",
	"mail",
	"settings",
	"auth",
	"api",
	"apiSetup",
	"apiTool",
	"apiAuth",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/**
 * Full catalog. Catalogues may nest one level deeper than a flat
 * `key -> string` map (e.g. `compose.title.reply`), so the leaf is typed
 * recursively as `TranslationValue`. Typed this way on purpose: JSON module
 * shape (deep readonly records) would otherwise fight i18next's mutable
 * `Resource` type.
 */
export type TranslationValue = string | { [key: string]: TranslationValue };

export const resources: Record<Locale, Record<string, Record<string, TranslationValue>>> = {
	en: {
		common: enCommon,
		layout: enLayout,
		dashboard: enDashboard,
		domain: enDomain,
		domainDetails: enDomainDetails,
		editor: enEditor,
		aiPanel: enAiPanel,
		compose: enCompose,
		mailPanel: enMailPanel,
		mail: enMail,
		settings: enSettings,
		auth: enAuth,
		api: enApi,
		apiSetup: enApiSetup,
		apiTool: enApiTool,
		apiAuth: enApiAuth,
	},
	zh: {
		common: zhCommon,
		layout: zhLayout,
		dashboard: zhDashboard,
		domain: zhDomain,
		domainDetails: zhDomainDetails,
		editor: zhEditor,
		aiPanel: zhAiPanel,
		compose: zhCompose,
		mailPanel: zhMailPanel,
		mail: zhMail,
		settings: zhSettings,
		auth: zhAuth,
		api: zhApi,
		apiSetup: zhApiSetup,
		apiTool: zhApiTool,
		apiAuth: zhApiAuth,
	},
};
