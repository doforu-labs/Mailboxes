# Copyright (c) 2026 Doforu
# Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
#     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
#
# Thin wrapper, kept for people who expect `bash deploy.sh`. All of the logic
# lives in scripts/setup.mjs so that there is exactly one deployment path:
#
#   npm run setup                 create missing resources, migrate, build, deploy
#   npm run setup -- --dry-run    report what would happen, change nothing
#   bash deploy.sh --dry-run      the same thing
#
# The previous revision of this script ran `git add -A && git commit && git push
# origin main` at the end, which is far too destructive for something people run
# to deploy a Worker. That step is deliberately gone.

set -euo pipefail
cd "$(dirname "$0")"
exec node scripts/setup.mjs "$@"
