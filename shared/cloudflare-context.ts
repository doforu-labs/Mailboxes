// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * The React Router context key that carries the Worker bindings into loaders.
 *
 * It lives in `shared/` rather than in `workers/app.ts` for one reason: the root
 * route's loader needs to read one binding (`DEMO_MODE`, to decide whether to
 * render the read-only banner), and importing `workers/app.ts` from
 * `app/root.tsx` would drag the whole Worker — PostalMime, the setup routes and
 * `virtual:react-router/server-build` — into the browser bundle.
 *
 * Deliberately typed as the *minimum* the client-facing code needs, not as the
 * full `Env`: loaders that want the real bindings can widen it at the call site.
 */
import { createContext } from "react-router";

/** The only binding a loader may consult through this key. */
export type CloudflareContextEnv = {
	/** `"1"` only on the public demo instance. */
	DEMO_MODE?: string;
};

export type CloudflareContextValue = {
	env: CloudflareContextEnv;
	ctx: unknown;
};

export const cloudflareContext = createContext<CloudflareContextValue>();
