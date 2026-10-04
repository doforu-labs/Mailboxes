// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Distributed here as part of a work licensed under the AGPL-3.0-only (see LICENSE).

import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
    // Route middleware: powers the per-request i18next instance in
    // app/middleware/i18next.ts (see app/root.tsx `middleware` export).
    v8_middleware: true,
  },
} satisfies Config;
