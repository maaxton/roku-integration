<script>
  import { onMount, onDestroy } from 'svelte';
  import {
    JewelPage,
    Card,
    Button,
    Badge,
    Modal,
    Spinner,
    toasts
  } from '@waiveo/ui';

  // Same prefix the routes are mounted under (matches the sibling +page.svelte's
  // INTEGRATION_API constant so the two pages stay consistent).
  const API = '/api/extensions/roku-integration';

  // --- Fleet table state ---
  let players = [];
  let latestTag = null;
  let releaseMeta = null; // { tag, assetName, size, sha256 }
  let loading = true;
  let refreshing = false;
  let checkingRelease = false; // "Check for updates" (cache-bypass) in flight

  // dev_state can only be inferred as password_rejected AFTER a failed write op
  // (GET /fleet/players can't detect it — the digest 401 only happens on :80).
  // Keep a per-device overlay so the loud rejected state survives re-polls until
  // the next successful op clears it.
  let devStateOverride = {}; // { [id]: 'password_rejected' | ... }
  let rowBusy = {}; // { [id]: true } — per-row op in flight

  // --- Op polling (re-poll /fleet/players while any op runs) ---
  let opPollTimer = null;
  let opRefcount = 0;

  // --- Reset confirm modal ---
  let showResetModal = false;
  let resetTarget = null;

  // --- Update-all modal ---
  let showUpdateAllModal = false;
  let updateAllPhase = 'confirm'; // 'confirm' | 'running' | 'done'
  let updateAllResults = [];
  let updateAllSummary = null; // { total, updated, failed, tag }

  // --- Dev Credentials panel ---
  let showCredsPanel = false;
  let creds = { user: 'rokudev', fleet: { set: false, masked: null }, devices: [] };
  let credsLoading = false;
  let fleetPwInput = '';
  let savingFleet = false;
  let devScopeId = '';
  let devPwInput = '';
  let savingDevice = false;

  // --- WebSocket unsubscribe handles ---
  let unsubAdded = null;
  let unsubRemoved = null;

  onMount(async () => {
    loading = true;
    await Promise.all([loadPlayers(), loadRelease()]);
    loadCreds(); // background — panel is collapsed by default
    loading = false;

    if (typeof window !== 'undefined' && window.waiveoWebSocket) {
      unsubAdded = window.waiveoWebSocket.subscribe('device:added', handleDeviceChanged);
      unsubRemoved = window.waiveoWebSocket.subscribe('device:removed', handleDeviceChanged);
    }
  });

  onDestroy(() => {
    if (unsubAdded) unsubAdded();
    if (unsubRemoved) unsubRemoved();
    stopOpPolling(true);
  });

  function handleDeviceChanged(payload) {
    // A Roku was added/removed from the registry — re-fetch the aggregate.
    const dev = payload?.device;
    if (payload?.deviceId || dev == null
        || dev.device_type === 'roku' || dev.integration === 'roku-integration') {
      loadPlayers();
    }
  }

  // ---------------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------------
  // refresh=true adds ?refresh=1, which makes the server bypass its release
  // metadata cache (30s TTL) and hit GitHub directly.
  async function loadPlayers(refresh = false) {
    try {
      const res = await fetch(`${API}/fleet/players${refresh ? '?refresh=1' : ''}`);
      const data = await res.json();
      if (data.success) {
        players = data.players || [];
        latestTag = data.latest_tag || latestTag;
      }
    } catch (err) {
      console.error('Failed to load players:', err);
    }
  }

  async function loadRelease(refresh = false) {
    try {
      const res = await fetch(`${API}/fleet/release/latest${refresh ? '?refresh=1' : ''}`);
      const data = await res.json();
      if (data.success && data.release) {
        releaseMeta = data.release;
        latestTag = data.release.tag || latestTag;
      }
    } catch (err) {
      console.error('Failed to load latest release:', err);
    }
  }

  async function loadCreds() {
    credsLoading = true;
    try {
      const res = await fetch(`${API}/fleet/dev-credentials`);
      const data = await res.json();
      if (data.success) {
        creds = {
          user: data.user || 'rokudev',
          fleet: data.fleet || { set: false, masked: null },
          devices: data.devices || []
        };
      }
    } catch (err) {
      console.error('Failed to load dev credentials:', err);
    }
    credsLoading = false;
  }

  async function refreshAll() {
    refreshing = true;
    await Promise.all([loadPlayers(), loadRelease()]);
    if (showCredsPanel) await loadCreds();
    refreshing = false;
  }

  // "Check for updates" — re-fetch with the server-side release cache bypassed,
  // so a just-published player release shows up immediately.
  async function checkForUpdates() {
    if (checkingRelease) return;
    checkingRelease = true;
    const prevTag = latestTag;
    await Promise.all([loadRelease(true), loadPlayers(true)]);
    checkingRelease = false;
    if (latestTag && latestTag !== prevTag) {
      toasts.success(`New release available: ${latestTag}`);
    } else if (latestTag) {
      toasts.info(`Latest release is still ${latestTag}`);
    } else {
      toasts.error('Could not reach the release repo');
    }
  }

  // ---------------------------------------------------------------------------
  // Op polling — keep the table fresh while installs run
  // ---------------------------------------------------------------------------
  function startOpPolling() {
    opRefcount += 1;
    if (!opPollTimer) {
      opPollTimer = setInterval(loadPlayers, 4000);
    }
  }

  function stopOpPolling(force = false) {
    opRefcount = force ? 0 : Math.max(0, opRefcount - 1);
    if (opRefcount === 0 && opPollTimer) {
      clearInterval(opPollTimer);
      opPollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-device write ops
  // ---------------------------------------------------------------------------
  async function updateDevice(player) {
    if (rowBusy[player.id]) return;
    rowBusy = { ...rowBusy, [player.id]: true };
    startOpPolling();
    try {
      const res = await fetch(`${API}/devices/${player.id}/player/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      applyOpResult(player, data, `Updated ${player.name}`);
    } catch (err) {
      toasts.error(`Update failed: ${err.message}`);
    } finally {
      rowBusy = { ...rowBusy, [player.id]: false };
      stopOpPolling();
      await loadPlayers();
    }
  }

  function confirmReset(player) {
    resetTarget = player;
    showResetModal = true;
  }

  async function doReset() {
    const player = resetTarget;
    showResetModal = false;
    if (!player) return;
    if (rowBusy[player.id]) return;
    rowBusy = { ...rowBusy, [player.id]: true };
    startOpPolling();
    try {
      const res = await fetch(`${API}/devices/${player.id}/player/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      applyOpResult(player, data, `Reset player on ${player.name}`);
    } catch (err) {
      toasts.error(`Reset failed: ${err.message}`);
    } finally {
      rowBusy = { ...rowBusy, [player.id]: false };
      resetTarget = null;
      stopOpPolling();
      await loadPlayers();
    }
  }

  async function repairDevice(player) {
    if (rowBusy[player.id]) return;
    rowBusy = { ...rowBusy, [player.id]: true };
    try {
      const res = await fetch(`${API}/devices/${player.id}/player/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.success) {
        toasts.success(data.message || `Re-pair triggered on ${player.name}`);
      } else {
        toasts.error(data.error || `Re-pair failed on ${player.name}`);
      }
    } catch (err) {
      toasts.error(`Re-pair failed: ${err.message}`);
    } finally {
      rowBusy = { ...rowBusy, [player.id]: false };
      await loadPlayers();
    }
  }

  // Fold an op response into toasts + the dev_state overlay.
  function applyOpResult(player, data, successMsg) {
    if (data.success) {
      toasts.success(data.message || successMsg);
      // clear any stale rejected overlay now that the op succeeded
      if (devStateOverride[player.id]) {
        const next = { ...devStateOverride };
        delete next[player.id];
        devStateOverride = next;
      }
    } else {
      toasts.error(data.error || 'Operation failed');
      if (data.dev_state) {
        devStateOverride = { ...devStateOverride, [player.id]: data.dev_state };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Update-all (fleet)
  // ---------------------------------------------------------------------------
  function openUpdateAll() {
    updateAllPhase = 'confirm';
    updateAllResults = [];
    updateAllSummary = null;
    showUpdateAllModal = true;
  }

  async function confirmUpdateAll() {
    updateAllPhase = 'running';
    startOpPolling();
    try {
      const res = await fetch(`${API}/fleet/player/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // update all listed players
      });
      const data = await res.json();
      if (data.success) {
        updateAllResults = data.results || [];
        updateAllSummary = {
          total: data.total, updated: data.updated, failed: data.failed, tag: data.tag
        };
        updateAllPhase = 'done';
        if (data.failed > 0) {
          toasts.warning(`Fleet update finished: ${data.updated} ok, ${data.failed} failed`);
        } else {
          toasts.success(`Fleet updated to ${data.tag} (${data.updated}/${data.total})`);
        }
      } else {
        // 409 (already running) or download failure — surface + close running view
        toasts.error(data.error || 'Fleet update failed');
        updateAllPhase = 'confirm';
      }
    } catch (err) {
      toasts.error(`Fleet update failed: ${err.message}`);
      updateAllPhase = 'confirm';
    } finally {
      stopOpPolling();
      await loadPlayers();
    }
  }

  // ---------------------------------------------------------------------------
  // Dev credentials PUTs
  // ---------------------------------------------------------------------------
  async function putCred(scope, deviceId, password) {
    const body = { scope, password };
    if (scope === 'device') body.device_id = deviceId;
    const res = await fetch(`${API}/fleet/dev-credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  async function saveFleetCred() {
    if (!fleetPwInput) {
      toasts.error('Enter a password to set the fleet default');
      return;
    }
    savingFleet = true;
    try {
      const data = await putCred('fleet', null, fleetPwInput);
      if (data.success) {
        toasts.success('Fleet default dev password saved');
        fleetPwInput = ''; // never keep the plaintext around
        await Promise.all([loadCreds(), loadPlayers()]);
      } else {
        toasts.error(data.error || 'Failed to save');
      }
    } catch (err) {
      toasts.error(`Failed to save: ${err.message}`);
    }
    savingFleet = false;
  }

  async function clearFleetCred() {
    savingFleet = true;
    try {
      const data = await putCred('fleet', null, null);
      if (data.success) {
        toasts.info('Fleet default dev password cleared');
        await Promise.all([loadCreds(), loadPlayers()]);
      } else {
        toasts.error(data.error || 'Failed to clear');
      }
    } catch (err) {
      toasts.error(`Failed to clear: ${err.message}`);
    }
    savingFleet = false;
  }

  async function saveDeviceCred() {
    if (!devScopeId) {
      toasts.error('Pick a device');
      return;
    }
    if (!devPwInput) {
      toasts.error('Enter a password for the override');
      return;
    }
    savingDevice = true;
    try {
      const data = await putCred('device', devScopeId, devPwInput);
      if (data.success) {
        toasts.success('Per-device dev password saved');
        devPwInput = '';
        devScopeId = '';
        await Promise.all([loadCreds(), loadPlayers()]);
      } else {
        toasts.error(data.error || 'Failed to save');
      }
    } catch (err) {
      toasts.error(`Failed to save: ${err.message}`);
    }
    savingDevice = false;
  }

  async function clearDeviceCred(deviceId) {
    try {
      const data = await putCred('device', deviceId, null);
      if (data.success) {
        toasts.info('Per-device override cleared');
        await Promise.all([loadCreds(), loadPlayers()]);
      } else {
        toasts.error(data.error || 'Failed to clear');
      }
    } catch (err) {
      toasts.error(`Failed to clear: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Presentation helpers
  // ---------------------------------------------------------------------------
  function connVariant(state) {
    switch (state) {
      case 'paired': return 'success';   // green
      case 'stale-token': return 'warning'; // amber — needs a human to re-pair
      case 'revoked': return 'error';    // red
      case 'unpaired': return 'default'; // grey
      default: return 'default';         // unknown → neutral
    }
  }

  function connLabel(state) {
    switch (state) {
      case 'paired': return 'Paired';
      // Honest label: a stale token never resolves on its own — the player
      // must be re-paired. "Connecting" wrongly read as transient progress.
      case 'stale-token': return 'Re-pair needed';
      case 'revoked': return 'Revoked';
      case 'unpaired': return 'Unpaired';
      default: return 'Unknown';
    }
  }

  function connTitle(state) {
    switch (state) {
      case 'paired': return 'Player holds a live box-side token';
      case 'stale-token': return 'Heuristic: no live box token but the dev channel is foregrounded — the player is likely clinging to a token the box no longer honors. Re-pair to clear.';
      case 'revoked': return 'All box-side tokens for this device are revoked';
      case 'unpaired': return 'No box-side pairing token found for this serial';
      default: return 'Pairing state unknown (slidecast token table unavailable, or the device did not report a serial)';
    }
  }

  function devStateVariant(state) {
    switch (state) {
      case 'password_rejected': return 'error';
      case 'not_dev_mode': return 'error';
      case 'no_password': return 'warning';
      case 'ok': return 'success';
      case 'unreachable': return 'default';
      default: return 'default';
    }
  }

  function devStateLabel(state) {
    switch (state) {
      case 'password_rejected': return 'Password rejected';
      case 'not_dev_mode': return 'Not in dev mode';
      case 'no_password': return 'No password';
      case 'ok': return 'Dev OK';
      case 'unreachable': return 'Unreachable';
      default: return 'Unknown';
    }
  }

  function isLoudDevState(state) {
    return state === 'password_rejected' || state === 'not_dev_mode';
  }

  function displayDevState(player) {
    return devStateOverride[player.id] || player.dev_state || 'unknown';
  }

  $: updateAvailableCount = players.filter((p) => p.updateAvailable).length;
  $: pairedCount = players.filter((p) => p.conn_state === 'paired').length;
  $: attentionCount = players.filter(
    (p) => isLoudDevState(displayDevState(p))
      || p.conn_state === 'revoked'
      || p.conn_state === 'stale-token'
  ).length;
</script>

<JewelPage
  title="Roku Fleet"
  subtitle="Player version + pairing lifecycle across every Roku screen"
  icon="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
  iconGradient="purple"
>
  <svelte:fragment slot="actions">
    <Button variant="secondary" on:click={refreshAll} loading={refreshing}>
      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Refresh
    </Button>
    <Button variant="primary" on:click={openUpdateAll} disabled={players.length === 0}>
      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      Update all
    </Button>
  </svelte:fragment>

  <!-- Summary strip -->
  <div class="fleet-summary">
    <Card padding="md" hover={false} class="summary-card">
      <div class="summary-value">{players.length}</div>
      <div class="summary-label">Players</div>
    </Card>
    <Card padding="md" hover={false} class="summary-card">
      <div class="summary-value">{latestTag || '—'}</div>
      <div class="summary-label">Latest release</div>
      <button
        type="button"
        class="summary-action"
        on:click={checkForUpdates}
        disabled={checkingRelease}
        title="Bypass the release cache and query the release repo now"
      >
        {checkingRelease ? 'Checking…' : 'Check for updates'}
      </button>
    </Card>
    <Card padding="md" hover={false} class="summary-card {updateAvailableCount > 0 ? 'warn' : ''}">
      <div class="summary-value">{updateAvailableCount}</div>
      <div class="summary-label">Update available</div>
    </Card>
    <Card padding="md" hover={false} class="summary-card ok">
      <div class="summary-value">{pairedCount}</div>
      <div class="summary-label">Paired</div>
    </Card>
    <Card padding="md" hover={false} class="summary-card {attentionCount > 0 ? 'alert' : ''}">
      <div class="summary-value">{attentionCount}</div>
      <div class="summary-label">Needs attention</div>
    </Card>
  </div>

  {#if loading}
    <div class="loading-state">
      <Spinner size="lg" />
      <p>Loading fleet…</p>
    </div>
  {:else if players.length === 0}
    <Card padding="lg" hover={false}>
      <div class="empty-state">
        <h3>No Roku players</h3>
        <p>Roku devices appear here once discovered or added on the Roku Devices page.</p>
      </div>
    </Card>
  {:else}
    <Card padding="none" hover={false} class="fleet-table-card">
      <div class="fleet-table-scroll">
        <table class="fleet-table">
          <thead>
            <tr>
              <th>Screen</th>
              <th>IP / Serial</th>
              <th>Installed version</th>
              <th>Connection</th>
              <th>Dev state</th>
              <th class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each players as p (p.id)}
              {@const dstate = displayDevState(p)}
              <tr class:row-busy={rowBusy[p.id]} class:row-alert={isLoudDevState(dstate)}>
                <!-- Screen -->
                <td>
                  <div class="cell-name">{p.name}</div>
                  <div class="cell-sub">
                    {#if p.online}
                      <span class="dot online" title="Reachable over ECP"></span> online
                    {:else}
                      <span class="dot offline" title="No ECP response"></span> offline
                    {/if}
                    {#if p.active_app}· {p.active_app}{/if}
                  </div>
                </td>

                <!-- IP / Serial -->
                <td>
                  <div class="cell-mono">{p.ip_address || '—'}</div>
                  <div class="cell-sub cell-mono">{p.serial_number || 'no serial'}</div>
                </td>

                <!-- Installed version -->
                <td>
                  <Badge variant={p.updateAvailable ? 'warning' : (p.installed_version ? 'success' : 'default')}>
                    {p.installed_version || 'not installed'}
                  </Badge>
                  {#if p.updateAvailable && p.latest_tag}
                    <span class="version-arrow" title="Update available">→ {p.latest_tag}</span>
                  {:else if p.version_state === 'ahead'}
                    <span class="version-note" title="On-device build is newer than the published tag">ahead</span>
                  {/if}
                </td>

                <!-- Connection / pairing (no pulse on stale-token: it needs a
                     human to re-pair, so it must not read as in-progress) -->
                <td>
                  <span title={connTitle(p.conn_state)}>
                    <Badge variant={connVariant(p.conn_state)}>
                      {connLabel(p.conn_state)}
                    </Badge>
                  </span>
                </td>

                <!-- Dev state chip (loud on password_rejected / not_dev_mode) -->
                <td>
                  <span title={devStateOverride[p.id] ? 'From the last install attempt on this device' : ''}>
                    <Badge variant={devStateVariant(dstate)} pulse={isLoudDevState(dstate)}>
                      {devStateLabel(dstate)}
                    </Badge>
                  </span>
                </td>

                <!-- Actions -->
                <td class="actions-col">
                  <div class="row-actions">
                    {#if rowBusy[p.id]}
                      <Spinner size="sm" />
                    {/if}
                    <Button
                      variant="primary"
                      size="sm"
                      on:click={() => updateDevice(p)}
                      disabled={rowBusy[p.id]}
                    >Update</Button>
                    <Button
                      variant="danger"
                      size="sm"
                      on:click={() => confirmReset(p)}
                      disabled={rowBusy[p.id]}
                    >Reset</Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      on:click={() => repairDevice(p)}
                      disabled={rowBusy[p.id]}
                    >Re-pair</Button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>
  {/if}

  <!-- ================= Dev Credentials panel (collapsible) ================= -->
  <Card padding="none" hover={false} class="creds-card">
    <button
      type="button"
      class="creds-toggle"
      on:click={() => { showCredsPanel = !showCredsPanel; if (showCredsPanel) loadCreds(); }}
      aria-expanded={showCredsPanel}
    >
      <svg class="chevron" class:open={showCredsPanel} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <span class="creds-title">Dev Credentials</span>
      <span class="creds-hint">
        user <code>{creds.user}</code> · plaintext-at-rest (LAN dev password) · never shown after saving
      </span>
    </button>

    {#if showCredsPanel}
      <div class="creds-body">
        {#if credsLoading}
          <div class="creds-loading"><Spinner size="md" /></div>
        {:else}
          <!-- Fleet default -->
          <div class="creds-section">
            <div class="creds-section-head">
              <h4>Fleet default</h4>
              {#if creds.fleet.set}
                <Badge variant="success">Set {creds.fleet.masked}</Badge>
              {:else}
                <Badge variant="default">Not set</Badge>
              {/if}
            </div>
            <p class="creds-desc">
              Used for any device without a per-device override. Source it from
              <code>~/.config/waiveo/dev-lab.env</code> — do not paste a shared secret into chat.
            </p>
            <div class="creds-form">
              <input
                type="password"
                class="creds-input"
                placeholder="New fleet dev password"
                autocomplete="new-password"
                bind:value={fleetPwInput}
              />
              <Button variant="primary" on:click={saveFleetCred} loading={savingFleet}>Save</Button>
              <Button variant="ghost" on:click={clearFleetCred} disabled={!creds.fleet.set || savingFleet}>Clear</Button>
            </div>
          </div>

          <!-- Per-device override -->
          <div class="creds-section">
            <div class="creds-section-head">
              <h4>Per-device override</h4>
            </div>
            <p class="creds-desc">Overrides the fleet default for one screen (keyed by hardware serial).</p>
            <div class="creds-form">
              <select class="creds-input" bind:value={devScopeId}>
                <option value="">Select a device…</option>
                {#each creds.devices as d}
                  <option value={d.device_id}>
                    {d.name}{d.serial ? ` (${d.serial})` : ''}{d.set ? ' — override set' : ''}
                  </option>
                {/each}
              </select>
              <input
                type="password"
                class="creds-input"
                placeholder="Override password"
                autocomplete="new-password"
                bind:value={devPwInput}
              />
              <Button variant="primary" on:click={saveDeviceCred} loading={savingDevice}>Save</Button>
            </div>

            {#if creds.devices.some((d) => d.set)}
              <ul class="override-list">
                {#each creds.devices.filter((d) => d.set) as d}
                  <li>
                    <span class="override-name">{d.name}</span>
                    <span class="override-serial cell-mono">{d.serial || '—'}</span>
                    <Badge variant="success">{d.masked}</Badge>
                    <Button variant="ghost" size="sm" on:click={() => clearDeviceCred(d.device_id)}>Clear</Button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </Card>
</JewelPage>

<!-- ===================== Reset confirm modal ===================== -->
<Modal bind:open={showResetModal} title="Reset player?" size="sm">
  <div class="modal-body">
    <p>
      This deletes the Waiveo dev channel on
      <strong>{resetTarget?.name}</strong> and reinstalls the latest release
      ({latestTag || 'latest'}). The screen will relaunch and re-pair.
    </p>
    <p class="modal-warn">Only do this on a wedged player — it interrupts whatever is on screen.</p>
  </div>
  <svelte:fragment slot="footer">
    <Button variant="ghost" on:click={() => { showResetModal = false; resetTarget = null; }}>Cancel</Button>
    <Button variant="danger" on:click={doReset}>Reset player</Button>
  </svelte:fragment>
</Modal>

<!-- ===================== Update-all modal ===================== -->
<Modal bind:open={showUpdateAllModal} title="Update all players" size="md" persistent={updateAllPhase === 'running'}>
  {#if updateAllPhase === 'confirm'}
    <div class="modal-body">
      <p>
        Install <strong>{latestTag || 'the latest release'}</strong> on all
        <strong>{players.length}</strong> Roku player{players.length === 1 ? '' : 's'}.
      </p>
      <p class="modal-warn">
        Installs run one at a time to spare the box and LAN. Each screen briefly relaunches.
      </p>
    </div>
  {:else if updateAllPhase === 'running'}
    <div class="modal-body">
      <div class="running-head">
        <Spinner size="md" />
        <span>Rolling out {latestTag || 'the latest release'} — one device at a time…</span>
      </div>
      <ul class="rollup-list">
        {#each players as p (p.id)}
          <li>
            <span class="rollup-name">{p.name}</span>
            {#if rowBusy[p.id]}
              <Badge variant="info" pulse>installing…</Badge>
            {:else}
              <Badge variant={p.updateAvailable ? 'warning' : 'success'}>
                {p.installed_version || '—'}
              </Badge>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="modal-warn">Leave this open until it finishes — closing won't stop the server-side roll.</p>
    </div>
  {:else}
    <div class="modal-body">
      {#if updateAllSummary}
        <div class="rollup-summary">
          <Badge variant={updateAllSummary.failed > 0 ? 'warning' : 'success'}>
            {updateAllSummary.updated}/{updateAllSummary.total} updated to {updateAllSummary.tag}
          </Badge>
          {#if updateAllSummary.failed > 0}
            <Badge variant="error">{updateAllSummary.failed} failed</Badge>
          {/if}
        </div>
      {/if}
      <ul class="rollup-list">
        {#each updateAllResults as r (r.id)}
          <li>
            <span class="rollup-name">{r.name}</span>
            {#if r.ok}
              <Badge variant="success">{r.version || 'ok'}</Badge>
            {:else}
              <span class="rollup-err" title={r.error}>
                <Badge variant="error">failed</Badge>
                <span class="rollup-err-msg">{r.error}</span>
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <svelte:fragment slot="footer">
    {#if updateAllPhase === 'confirm'}
      <Button variant="ghost" on:click={() => showUpdateAllModal = false}>Cancel</Button>
      <Button variant="primary" on:click={confirmUpdateAll}>Update {players.length} players</Button>
    {:else if updateAllPhase === 'done'}
      <Button variant="primary" on:click={() => showUpdateAllModal = false}>Done</Button>
    {/if}
  </svelte:fragment>
</Modal>

<style>
  /* Summary strip */
  .fleet-summary {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: var(--jewel-space-md);
    margin-bottom: var(--jewel-space-lg);
  }

  @media (max-width: 900px) {
    .fleet-summary {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  :global(.summary-card) {
    text-align: center;
  }

  .summary-value {
    font-size: 1.75rem;
    font-weight: 700;
    color: rgb(var(--color-text));
  }

  .summary-label {
    font-size: 0.8rem;
    color: rgb(var(--color-text-secondary));
  }

  .summary-action {
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    font-size: 0.72rem;
    color: rgb(var(--color-primary));
    cursor: pointer;
  }

  .summary-action:hover:not(:disabled) {
    text-decoration: underline;
  }

  .summary-action:disabled {
    color: rgb(var(--color-text-tertiary));
    cursor: default;
  }

  :global(.summary-card.ok) .summary-value {
    color: rgb(var(--color-success));
  }

  :global(.summary-card.warn) .summary-value {
    color: rgb(234, 179, 8);
  }

  :global(.summary-card.alert) .summary-value {
    color: rgb(248, 113, 113);
  }

  /* States */
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--jewel-space-md);
    padding: var(--jewel-space-xl);
    color: rgb(var(--color-text-secondary));
  }

  .empty-state {
    text-align: center;
    padding: var(--jewel-space-xl) var(--jewel-space-lg);
  }

  .empty-state h3 {
    font-size: 1rem;
    font-weight: 600;
    color: rgb(var(--color-text));
    margin: 0 0 var(--jewel-space-xs) 0;
  }

  .empty-state p {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
    margin: 0;
  }

  /* Fleet table */
  :global(.fleet-table-card) {
    margin-bottom: var(--jewel-space-lg);
  }

  .fleet-table-scroll {
    overflow-x: auto;
  }

  .fleet-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .fleet-table thead th {
    text-align: left;
    padding: var(--jewel-space-sm) var(--jewel-space-md);
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgb(var(--color-text-tertiary));
    border-bottom: 1px solid rgb(var(--color-border));
    white-space: nowrap;
  }

  .fleet-table tbody td {
    padding: var(--jewel-space-sm) var(--jewel-space-md);
    border-bottom: 1px solid rgb(var(--color-border) / 0.5);
    vertical-align: middle;
  }

  .fleet-table tbody tr:last-child td {
    border-bottom: none;
  }

  .fleet-table tbody tr.row-busy {
    opacity: 0.7;
  }

  .fleet-table tbody tr.row-alert {
    background: rgb(248, 113, 113, 0.06);
  }

  .cell-name {
    font-weight: 600;
    color: rgb(var(--color-text));
  }

  .cell-sub {
    font-size: 0.75rem;
    color: rgb(var(--color-text-secondary));
    margin-top: 2px;
  }

  .cell-mono {
    font-family: var(--jewel-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.8rem;
    color: rgb(var(--color-text));
  }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 2px;
  }

  .dot.online { background: rgb(74, 222, 128); }
  .dot.offline { background: rgb(156, 163, 175); }

  .version-arrow {
    margin-left: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    color: rgb(234, 179, 8);
  }

  .version-note {
    margin-left: 6px;
    font-size: 0.72rem;
    color: rgb(var(--color-text-tertiary));
    font-style: italic;
  }

  .actions-col {
    text-align: right;
  }

  .row-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--jewel-space-xs);
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  /* Dev Credentials panel */
  :global(.creds-card) {
    margin-bottom: var(--jewel-space-lg);
  }

  .creds-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--jewel-space-sm);
    padding: var(--jewel-space-md);
    background: transparent;
    border: none;
    cursor: pointer;
    color: rgb(var(--color-text));
    text-align: left;
  }

  .creds-toggle:hover {
    background: rgb(var(--color-surface-elevated) / 0.5);
  }

  .chevron {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    transition: transform 0.15s ease;
    color: rgb(var(--color-text-secondary));
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .creds-title {
    font-weight: 600;
  }

  .creds-hint {
    font-size: 0.75rem;
    color: rgb(var(--color-text-tertiary));
    margin-left: auto;
  }

  .creds-hint code,
  .creds-desc code {
    font-family: var(--jewel-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.72rem;
    background: rgb(var(--color-surface-elevated));
    padding: 1px 5px;
    border-radius: 4px;
  }

  .creds-body {
    padding: 0 var(--jewel-space-md) var(--jewel-space-md);
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-lg);
    border-top: 1px solid rgb(var(--color-border));
  }

  .creds-loading {
    display: flex;
    justify-content: center;
    padding: var(--jewel-space-lg);
  }

  .creds-section {
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-sm);
    padding-top: var(--jewel-space-md);
  }

  .creds-section-head {
    display: flex;
    align-items: center;
    gap: var(--jewel-space-sm);
  }

  .creds-section-head h4 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: rgb(var(--color-text));
  }

  .creds-desc {
    font-size: 0.8rem;
    color: rgb(var(--color-text-secondary));
    margin: 0;
    line-height: 1.4;
  }

  .creds-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--jewel-space-sm);
    align-items: center;
  }

  .creds-input {
    flex: 1 1 200px;
    min-width: 160px;
    padding: var(--jewel-space-sm) var(--jewel-space-md);
    border: 1px solid rgb(var(--color-border));
    border-radius: var(--jewel-radius-md);
    background: rgb(var(--color-surface));
    color: rgb(var(--color-text));
    font-size: 0.9rem;
  }

  .creds-input:focus {
    outline: none;
    border-color: rgb(var(--color-primary));
  }

  .override-list {
    list-style: none;
    margin: var(--jewel-space-xs) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-xs);
  }

  .override-list li {
    display: flex;
    align-items: center;
    gap: var(--jewel-space-sm);
    padding: var(--jewel-space-xs) var(--jewel-space-sm);
    background: rgb(var(--color-surface-elevated));
    border-radius: var(--jewel-radius-md);
  }

  .override-name {
    font-weight: 500;
    color: rgb(var(--color-text));
  }

  .override-serial {
    color: rgb(var(--color-text-secondary));
  }

  .override-list li :global(button) {
    margin-left: auto;
  }

  /* Modals */
  .modal-body {
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-sm);
  }

  .modal-body p {
    margin: 0;
    color: rgb(var(--color-text));
    line-height: 1.5;
  }

  .modal-warn {
    font-size: 0.85rem;
    color: rgb(var(--color-text-secondary));
  }

  .running-head {
    display: flex;
    align-items: center;
    gap: var(--jewel-space-md);
    color: rgb(var(--color-text));
  }

  .rollup-summary {
    display: flex;
    gap: var(--jewel-space-sm);
    flex-wrap: wrap;
  }

  .rollup-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 340px;
    overflow-y: auto;
  }

  .rollup-list li {
    display: flex;
    align-items: center;
    gap: var(--jewel-space-sm);
    padding: 6px var(--jewel-space-sm);
    border-radius: var(--jewel-radius-md);
    background: rgb(var(--color-surface-elevated) / 0.5);
  }

  .rollup-name {
    font-weight: 500;
    color: rgb(var(--color-text));
  }

  .rollup-err {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--jewel-space-sm);
    min-width: 0;
  }

  .rollup-err-msg {
    font-size: 0.75rem;
    color: rgb(248, 113, 113);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
  }

  .rollup-list li :global(.jewel-badge) {
    margin-left: auto;
  }

  .rollup-err :global(.jewel-badge) {
    margin-left: 0;
  }
</style>
