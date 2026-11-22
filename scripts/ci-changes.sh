#!/usr/bin/env bash
# CI's first step after the checkout (ci.yml, both test jobs): writes code=false to
# $GITHUB_OUTPUT when a pull request changes only kb/, which nothing that is built or
# tested reads, and code=true otherwise; the job's later steps run only on code=true.
#
# The pull request's changes are its merge commit (HEAD) against the base (HEAD^1),
# which the checkout fetches with fetch-depth 2. Without rename detection, so a file
# moved into kb/ counts as deleted where it was; every kind of change is listed
# (no --diff-filter). A push, a missing merge commit or an empty diff run everything.
# EVENT is github.event_name. scripts/ci-changes.test.ts runs it on a scratch
# repository.
set -euo pipefail

code=true
if [ "${EVENT:-}" = pull_request ] && git rev-parse --verify --quiet HEAD^2 > /dev/null; then
  changed=$(git diff --name-only --no-renames HEAD^1 HEAD)
  git diff --stat --no-renames HEAD^1 HEAD | tail -n 1
  # A here-string, not a pipe: with pipefail, grep -q leaving early could fail printf.
  if [ -n "$changed" ] && ! grep -qv '^kb/' <<< "$changed"; then
    echo "Only kb/ changed: nothing to build or test."
    code=false
  fi
fi
echo "code=$code" >> "$GITHUB_OUTPUT"
