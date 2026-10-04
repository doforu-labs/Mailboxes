// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Canonical locale identifiers supported by the app.
 *
 * Kept intentionally tiny: English is the default and fallback, Chinese is
 * the only other supported language. Everything (frontend + Workers) imports
 * this union so a typo in a locale string is a compile error.
 */
export type Locale = "en" | "zh";
