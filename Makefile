.PHONY: lint fmt test test-deploy typecheck demo-remote-sandbox demo-remote-sandbox-teardown \
	demo-promoted-workflow demo-promoted-workflow-teardown

lint:
	pre-commit run --all-files

fmt:
	pnpm exec prettier --write .

test:
	pnpm -r test
	cd remote-worker && go test ./...
	$(MAKE) test-deploy

# Cluster-free unit tests for the deploy/ shell scripts: kubectl, kind and docker are
# mocked on PATH and only the call log is asserted. Run in CI by the `deploy-scripts` job.
# `set -e` so one failing test file fails the target instead of being scrolled past.
# deploy/claude/tests covers the /promote slash-command asset, which nothing else type-checks.
test-deploy:
	@set -e; for t in deploy/knative/tests/*.test.sh deploy/claude/tests/*.test.sh; do echo "== $$t"; bash "$$t"; done

# One recursive run, so this target and CI cannot drift apart by editing a list in one of
# them -- which they had, in both directions (#191): config-bundle was checked only here,
# sandbox-relay and ibac-stub only in CI. The package set is now whichever packages declare
# a `typecheck` script, and harness/test/typecheck-coverage.test.ts asserts they all do
# (`pnpm -r` skips a package that does not, silently, and still exits 0).
typecheck:
	pnpm -r typecheck

# Laptop showcase: harness on kind, remote worker as a host container dialing out.
# See deploy/knative/README-worker.md. Add --reuse-cluster to skip setup on a warm cluster.
demo-remote-sandbox:
	bash deploy/knative/demo-remote-worker.sh $(DEMO_ARGS)

demo-remote-sandbox-teardown:
	bash deploy/knative/demo-remote-worker.sh --teardown

# Promote a Claude Code workflow authored in a minimal local sandbox, then prove it ran remotely.
# Needs a warm cluster whose image contains the promotion feature; the script gates on that.
# See docs/demos/promoted-workflow-demo.md.
demo-promoted-workflow:
	bash deploy/knative/demo-promoted-workflow.sh $(DEMO_ARGS)

demo-promoted-workflow-teardown:
	bash deploy/knative/demo-promoted-workflow.sh --teardown
