// Drops progress left in state.json by a retired feature. Right now the only
// tenant is the long warm-up (F37): an older version of this project could
// leave `state.warmup` behind, which is meaningless once the warm-up itself
// is gone. Called once at startup so the stale value never survives the next
// periodic store.flush(); never throws, never touches anything else under
// data/.

import { log } from '../log.js';

/**
 * @param {{ state: { data: object, markDirty: () => void } }} store
 * @returns {boolean} true when stale warm-up progress was found and dropped
 */
export function dropStaleWarmupProgress(store) {
  if (!store?.state?.data?.warmup) return false;
  delete store.state.data.warmup;
  store.state.markDirty();
  log.info('index: dropped stale warm-up progress from state.json');
  return true;
}
