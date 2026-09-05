#!/usr/bin/env bash
# Deploy the remote-worker as an in-cluster pod and verify it registers with the
# relay. This closes the port-forward latency gap: relay->worker execs stay in the
# cluster, so harness leaf execs reach the worker within their deadline.
#
#   ./build-image.sh && ./deploy-incluster.sh
#   NS=default SANDBOX_ID=sbx-worker-1 ./deploy-incluster.sh
#   IMAGE=quay.io/aslomnet/remote-worker:dev ./deploy-incluster.sh   # external image
set -euo pipefail
cd "$(dirname "$0")"

NS="${NS:-default}"
SANDBOX_ID="${SANDBOX_ID:-sbx-worker-1}"
TOKEN="${SANDBOX_TOKEN:-dev-token}"
IMAGE="${IMAGE:-image-registry.openshift-image-registry.svc:5000/$NS/remote-worker:latest}"

# One Secret, one key, read by both the relay (SH_RELAY_TOKEN) and the worker
# (SANDBOX_TOKEN, see worker-deployment.yaml). Auth is fail-closed and the two values must be
# equal, so sourcing both from one key makes that structural.
SECRET_NAME="sh-relay-token"
SECRET_KEY="SH_RELAY_TOKEN"

echo "==> relay token Secret (fail-closed auth)"
# `create --dry-run=client | apply` so re-running rotates the value instead of failing on a
# Secret that already exists. The token is still on this process's argv -- visible to `ps` on
# this machine for the life of the command -- but it no longer lands in either Deployment
# spec, where it persisted for anyone with read access to the namespace (#173).
oc create secret generic "$SECRET_NAME" -n "$NS" \
  --from-literal="$SECRET_KEY=$TOKEN" --dry-run=client -o yaml | oc apply -f - >/dev/null

echo "==> point the relay at the Secret"
# Replaces any literal SH_RELAY_TOKEN a previous run of this script set with a secretKeyRef.
oc set env deploy/sandbox-relay --from="secret/$SECRET_NAME" -n "$NS" >/dev/null
# Then force a new pod. Env from a secretKeyRef is resolved once, at container start, so
# rewriting the Secret above does NOT reach a running relay -- and on a re-run the `set env`
# is a no-op (the spec already names the Secret), so nothing else would trigger a rollout.
# Left out, a rotated token leaves the relay serving the previous one: both sides stay stale
# and keep matching, until either pod restarts on its own and they disagree, at which point
# fail-closed auth rejects every Attach for a reason nothing in the specs explains.
oc rollout restart deploy/sandbox-relay -n "$NS" >/dev/null
oc rollout status deploy/sandbox-relay -n "$NS" --timeout=120s

echo "==> ServiceAccount + nonroot-v2 SCC (image declares USER 1001)"
oc create serviceaccount remote-worker -n "$NS" --dry-run=client -o yaml | oc apply -f - >/dev/null
oc adm policy add-scc-to-user nonroot-v2 -z remote-worker -n "$NS" >/dev/null

echo "==> apply Deployment (image=$IMAGE sandbox_id=$SANDBOX_ID)"
sed -e "s#__IMAGE__#${IMAGE}#g" -e "s#__SANDBOX_ID__#${SANDBOX_ID}#g" \
    -e "s#__NS__#${NS}#g" \
    worker-deployment.yaml | oc apply -f - >/dev/null

# Same reason as the relay restart above: the rendered Deployment is byte-identical between
# runs, so a rotated token would not otherwise reach the worker's running pod either.
oc rollout restart deploy/remote-worker -n "$NS" >/dev/null
oc rollout status deploy/remote-worker -n "$NS" --timeout=120s

echo "==> presence in Redis (worker registered via its live Attach stream)"
for _ in $(seq 1 20); do
  rec="$(oc exec deploy/redis -n "$NS" -- redis-cli HGET sh:sandbox:records "$SANDBOX_ID" 2>/dev/null || true)"
  [ -n "$rec" ] && { echo "$rec"; break; }
  sleep 1
done
[ -n "${rec:-}" ] || { echo "NOT registered — check: oc logs deploy/remote-worker -n $NS"; exit 1; }
echo "==> worker log:"; oc logs deploy/remote-worker -n "$NS" --tail=5 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g'
echo "OK. Drive a leaf: POST a LeafEnvelope to the harness /runs (see DESIGN.md)."
