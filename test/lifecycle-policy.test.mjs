/**
 * The one rule that stops a container nobody asked to stop.
 *
 * Every other probe outcome is fail-open by design: an unreachable OpenCode is
 * not evidence that its work finished. This bound is what keeps that from
 * becoming a leak, so its edges are pinned here — it is the difference between
 * a container the policy gave up on and one it is still waiting for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PROBE_FAILURE_WINDOW_MS,
  probeFailureWindowExpired
} from '../src/lifecycle-policy.ts';

const NOW = Date.UTC(2026, 7, 16);
const failing = (sinceMsAgo) => ({
  phase: 'error_running',
  probeFailingSince: NOW - sinceMsAgo
});

test('a container unreachable past the window is given up on', () => {
  assert.equal(
    probeFailureWindowExpired(failing(MAX_PROBE_FAILURE_WINDOW_MS), NOW),
    true
  );
  assert.equal(
    probeFailureWindowExpired(failing(MAX_PROBE_FAILURE_WINDOW_MS * 24), NOW),
    true
  );
});

test('a container still inside the window is left alone', () => {
  assert.equal(
    probeFailureWindowExpired(failing(MAX_PROBE_FAILURE_WINDOW_MS - 1), NOW),
    false
  );
  assert.equal(probeFailureWindowExpired(failing(0), NOW), false);
});

test('only a failing phase counts', () => {
  // A probe that succeeds clears `probeFailingSince`, but a phase that never
  // reached error_running must not be stopped even if one lingered: the
  // container is answering, which is the whole point of the window.
  for (const phase of [
    'running_busy',
    'running_idle',
    'running_unknown',
    'quiescing',
    'waking',
    'sleeping'
  ]) {
    assert.equal(
      probeFailureWindowExpired(
        { phase, probeFailingSince: NOW - MAX_PROBE_FAILURE_WINDOW_MS * 10 },
        NOW
      ),
      false,
      phase
    );
  }
});

test('a run of failures that never started does not expire', () => {
  // The field is absent until the first failure, so a fresh error_running
  // state cannot be old enough to stop.
  assert.equal(probeFailureWindowExpired({ phase: 'error_running' }, NOW), false);
});

test('the window is long enough to outlast a restart, short enough to matter', () => {
  // The failure this exists for ran for twelve days. The window has to be
  // comfortably longer than a deploy or a daemon restart and far shorter than
  // the three-day sweep that is the only other thing which would reclaim it.
  assert.ok(MAX_PROBE_FAILURE_WINDOW_MS >= 15 * 60 * 1000);
  assert.ok(MAX_PROBE_FAILURE_WINDOW_MS <= 6 * 60 * 60 * 1000);
});
