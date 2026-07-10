<script>
  // Roku "deviceTabs" contribution (spec §6 / D9, Wave 5 Slice 5.3) — the
  // end-to-end proof of the deviceType-filtered contribution slot. Declared
  // in ../../../index.js's `contributions.deviceTabs` with deviceType:
  // 'roku', so device-discovery's device-detail Modal only mounts this tab
  // for devices it resolves as a Roku. Receives the device-discovery
  // CANDIDATE row as the `device` prop, threaded through
  // HostSlot -> ExtensionLoader -> here via componentProps (Slice 5.3's
  // component-prop-passing addition to the shared contribution-slot
  // plumbing).
  import { onMount } from 'svelte';

  export let device = null;

  let loading = true;
  let error = null;
  let rokuDevice = null; // entry from GET /devices matching this candidate
  let activeApp = null; // best-effort live ECP call, only when powered on

  $: claimedDeviceId = device?.claimed_device_id || null;

  onMount(async () => {
    if (!claimedDeviceId) {
      loading = false;
      return;
    }
    try {
      // The single-device GET /devices/:id route returns only identity
      // fields (findDevice() in index.js) — power/app state lives on the
      // list route, which enriches each device from entity_states. Fetch
      // the list and find our device rather than duplicating that join
      // client-side.
      const res = await fetch('/api/extensions/roku-integration/devices');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      rokuDevice = (data.devices || []).find(
        (d) => d.device_id === claimedDeviceId || d.id === claimedDeviceId,
      ) || null;

      // Best-effort live "now on screen" lookup — only worth the ECP
      // round-trip when the device looks powered on; failures (asleep,
      // unreachable) must not break the rest of the tab.
      if (rokuDevice?.power_state && rokuDevice.power_state !== 'off') {
        try {
          const appRes = await fetch(
            `/api/extensions/roku-integration/devices/${encodeURIComponent(claimedDeviceId)}/active-app`,
          );
          const appData = await appRes.json();
          if (appRes.ok && appData.success) activeApp = appData.activeApp;
        } catch {
          // best-effort only; power/model info above is the primary payload
        }
      }
    } catch (e) {
      error = e.message || 'Failed to load Roku status';
    } finally {
      loading = false;
    }
  });
</script>

<div class="roku-device-tab">
  {#if !claimedDeviceId}
    <p class="roku-tab-placeholder">
      This device hasn't been claimed by Roku Integration yet — claim it to see live power and app status.
    </p>
  {:else if loading}
    <p class="roku-tab-placeholder">Loading Roku status&hellip;</p>
  {:else if error}
    <p class="roku-tab-placeholder">{error}</p>
  {:else if !rokuDevice}
    <p class="roku-tab-placeholder">No matching Roku Integration device found.</p>
  {:else}
    <dl class="roku-tab-list">
      <div class="roku-tab-row">
        <dt>Power</dt>
        <dd>
          {#if rokuDevice.power_state === 'on'}
            <span class="roku-tab-power on">On</span>
          {:else if rokuDevice.power_state}
            <span class="roku-tab-power off">{rokuDevice.power_state}</span>
          {:else}
            <span class="roku-tab-power unknown">Unknown</span>
          {/if}
        </dd>
      </div>
      {#if activeApp?.name}
        <div class="roku-tab-row">
          <dt>Now on screen</dt>
          <dd>{activeApp.name}</dd>
        </div>
      {/if}
      {#if rokuDevice.model}
        <div class="roku-tab-row">
          <dt>Model</dt>
          <dd>{rokuDevice.model}</dd>
        </div>
      {/if}
      <div class="roku-tab-row">
        <dt>Connection</dt>
        <dd>{rokuDevice.status === 'online' ? 'Online' : 'Offline'}</dd>
      </div>
    </dl>
  {/if}
</div>

<style>
  .roku-device-tab {
    min-height: 4rem;
  }

  .roku-tab-placeholder {
    margin: 0;
    color: rgb(var(--color-text-secondary));
    font-size: 0.9rem;
  }

  .roku-tab-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-md, 0.75rem);
  }

  .roku-tab-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--jewel-space-md, 0.75rem);
    padding-bottom: var(--jewel-space-sm, 0.5rem);
    border-bottom: 1px solid rgb(var(--color-border));
  }

  .roku-tab-row:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .roku-tab-row dt {
    font-size: 0.85rem;
    color: rgb(var(--color-text-secondary));
  }

  .roku-tab-row dd {
    margin: 0;
    font-weight: 600;
    color: rgb(var(--color-text));
  }

  .roku-tab-power {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.6rem;
    border-radius: var(--jewel-radius-full, 999px);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .roku-tab-power.on {
    background: rgb(var(--color-success, 34, 197, 94) / 0.15);
    color: rgb(var(--color-success, 34, 197, 94));
  }

  .roku-tab-power.off {
    background: rgb(var(--color-text-secondary) / 0.15);
    color: rgb(var(--color-text-secondary));
  }

  .roku-tab-power.unknown {
    background: rgb(var(--color-warning, 245, 158, 11) / 0.15);
    color: rgb(var(--color-warning, 245, 158, 11));
  }
</style>
