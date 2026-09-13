#!/bin/bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CHECKOUT=${1:?usage: verify-macos.sh checkout [team-id]}
TEAM=${2:-}
CHECKOUT=$(cd "$CHECKOUT" && pwd -P)
bash "$SCRIPT_DIR/run-in-checkout.sh" "$CHECKOUT" --lock -- swift test \
  --package-path "$CHECKOUT/apps/macos" --scratch-path "$CHECKOUT/.fdrive-workflow/swift-build"
ARGS=(-project "$CHECKOUT/apps/macos/fdrive.xcodeproj" -scheme fdrive -configuration Debug
  -derivedDataPath "$CHECKOUT/.fdrive-workflow/macos-build-${TEAM:-unsigned}" -destination 'platform=macOS,arch=arm64' build)
if [[ -n $TEAM ]]; then
  ARGS+=("DEVELOPMENT_TEAM=$TEAM" -allowProvisioningUpdates)
else
  ARGS+=(CODE_SIGNING_ALLOWED=NO)
fi
bash "$SCRIPT_DIR/run-in-checkout.sh" "$CHECKOUT" --lock -- xcodebuild "${ARGS[@]}"
