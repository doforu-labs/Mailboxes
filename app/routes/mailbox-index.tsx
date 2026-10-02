// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Distributed here as part of a work licensed under the AGPL-3.0-only (see LICENSE).

import { Navigate } from "react-router";

export default function MailboxIndexRoute() {
  return <Navigate to="emails/inbox" replace />;
}
