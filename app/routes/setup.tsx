// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Loader } from "@cloudflare/kumo";

export function meta() {
  return [{ title: "Setup — Mailboxes" }];
}

export default function SetupRoute() {
  const navigate = useNavigate();
  
  useEffect(() => {
    navigate("/", { replace: true });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-kumo-recessed flex items-center justify-center">
      <div className="flex items-center gap-2 text-kumo-subtle">
        <Loader size="sm" />
        <span className="text-sm">Redirecting...</span>
      </div>
    </div>
  );
}
