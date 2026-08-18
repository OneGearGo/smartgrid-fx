// Lightweight crash-safe state persistence.
//
// A grid bot holds non-trivial in-memory state: its config, cumulative stats
// (volume / completed rungs / theoretical profit) and the starting balance used
// for return%. If the process restarts, all of that is lost while the REAL
// resting orders remain on the exchange — a dangerous "half-known grid".
//
// This module persists a small snapshot per exchange to a JSON file. On boot the
// server restores the snapshot (so the dashboard keeps showing cumulative stats)
// and, for any bot that was running, cancels stray orders for that market.
//
// It deliberately stores NO secrets — only public config + counters.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const STATE_FILE = path.join(ROOT, '.state.json');

let cache = null;
let saveTimer = null;

/** Read the whole state file once (cached). Returns {} on any problem. */
export function loadState() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Get a single bot's snapshot (e.g. key 'de'). */
export function loadSnapshot(key) {
  return loadState()[key] || null;
}

/** Persist one bot's snapshot under `key`, debounced to avoid thrashing disk. */
export function saveSnapshot(key, snapshot) {
  const state = loadState();
  state[key] = snapshot;
  cache = state;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, STATE_FILE); // atomic replace
    } catch { /* persistence must never crash trading */ }
  }, 500);
  saveTimer.unref?.();
}
