<script>
  import { onMount } from 'svelte';
  import {
    JewelPage,
    Card,
    Button,
    toasts
  } from '@waiveo/ui';

  let settings = {
    log_level: 'warn'
  };
  let loading = true;
  let saving = false;

  const LOG_LEVELS = [
    { value: 'debug', label: 'Debug', description: 'All messages including diagnostic details' },
    { value: 'info', label: 'Info', description: 'Normal operational messages' },
    { value: 'warn', label: 'Warning', description: 'Only warnings and errors (recommended)' },
    { value: 'error', label: 'Error', description: 'Only error messages' }
  ];

  function goto(path) {
    window.location.href = path;
  }

  onMount(async () => {
    await loadSettings();
  });

  async function loadSettings() {
    loading = true;
    try {
      const res = await fetch('/api/extensions/roku-integration/settings');
      const data = await res.json();
      if (data.success && data.settings) {
        settings = { ...settings, ...data.settings };
      }
    } catch (err) {
      // Use defaults
    } finally {
      loading = false;
    }
  }

  async function saveSettings() {
    saving = true;
    try {
      const res = await fetch('/api/extensions/roku-integration/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        toasts.success('Settings saved');
      } else {
        toasts.error(data.error || 'Failed to save settings');
      }
    } catch (err) {
      toasts.error('Failed to save settings');
    } finally {
      saving = false;
    }
  }
</script>

<div class="settings-page">
  <div class="page-header">
    <div class="header-content">
      <button class="back-btn" on:click={() => goto('/ext/roku-integration')}>
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
      </button>
      <div class="header-text">
        <h1>Roku Settings</h1>
        <p>Configure Roku Integration behavior</p>
      </div>
    </div>
  </div>

  <div class="settings-content">
    {#if loading}
      <Card padding="lg">
        <div class="loading">Loading settings...</div>
      </Card>
    {:else}
      <Card padding="lg">
        <h2 class="section-title">Logging</h2>
        <p class="section-description">Control how much detail is logged by the Roku integration. Logs are visible in the Logs page.</p>
        
        <div class="setting-group">
          <label class="setting-label">Log Level</label>
          <div class="log-level-options">
            {#each LOG_LEVELS as level}
              <button 
                class="log-level-btn" 
                class:active={settings.log_level === level.value}
                on:click={() => settings.log_level = level.value}
              >
                <span class="level-name">{level.label}</span>
                <span class="level-desc">{level.description}</span>
              </button>
            {/each}
          </div>
        </div>

        <div class="log-info">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4m0-4h.01" />
          </svg>
          <div>
            <strong>Note:</strong> Only <code>error</code> level logs appear in Docker logs. 
            All other levels only appear in the Logs UI (Settings → Logs).
          </div>
        </div>
      </Card>

      <div class="actions">
        <Button variant="primary" on:click={saveSettings} loading={saving}>
          Save Settings
        </Button>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings-page {
    min-height: 100vh;
    background: rgb(var(--color-background));
  }

  .page-header {
    background: rgb(var(--color-surface));
    border-bottom: 1px solid rgb(var(--color-border));
    padding: var(--jewel-space-lg) var(--jewel-space-xl);
  }

  .header-content {
    display: flex;
    align-items: center;
    gap: var(--jewel-space-md);
    max-width: 800px;
    margin: 0 auto;
  }

  .back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: var(--jewel-radius-md);
    background: transparent;
    color: rgb(var(--color-text-secondary));
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .back-btn:hover {
    background: rgb(var(--color-surface-elevated));
    color: rgb(var(--color-text));
  }

  .back-btn svg {
    width: 20px;
    height: 20px;
  }

  .header-text h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0;
    color: rgb(var(--color-text));
  }

  .header-text p {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
    margin: 4px 0 0 0;
  }

  .settings-content {
    max-width: 800px;
    margin: 0 auto;
    padding: var(--jewel-space-xl);
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-lg);
  }

  .loading {
    text-align: center;
    padding: var(--jewel-space-xl);
    color: rgb(var(--color-text-secondary));
  }

  .section-title {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 var(--jewel-space-xs) 0;
    color: rgb(var(--color-text));
  }

  .section-description {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
    margin: 0 0 var(--jewel-space-lg) 0;
  }

  .setting-group {
    margin-bottom: var(--jewel-space-lg);
  }

  .setting-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: rgb(var(--color-text));
    margin-bottom: var(--jewel-space-sm);
  }

  .log-level-options {
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-sm);
  }

  .log-level-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: var(--jewel-space-md);
    border: 1px solid rgb(var(--color-border));
    border-radius: var(--jewel-radius-md);
    background: rgb(var(--color-surface));
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .log-level-btn:hover {
    border-color: rgb(var(--color-primary) / 0.5);
    background: rgb(var(--color-surface-elevated));
  }

  .log-level-btn.active {
    border-color: rgb(var(--color-primary));
    background: rgb(var(--color-primary) / 0.1);
  }

  .level-name {
    font-weight: 600;
    color: rgb(var(--color-text));
  }

  .log-level-btn.active .level-name {
    color: rgb(var(--color-primary));
  }

  .level-desc {
    font-size: 0.8rem;
    color: rgb(var(--color-text-secondary));
    margin-top: 2px;
  }

  .log-info {
    display: flex;
    gap: var(--jewel-space-sm);
    padding: var(--jewel-space-md);
    background: rgb(var(--color-info) / 0.1);
    border-radius: var(--jewel-radius-md);
    font-size: 0.85rem;
    color: rgb(var(--color-text-secondary));
  }

  .log-info svg {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    color: rgb(var(--color-info));
  }

  .log-info code {
    background: rgb(var(--color-surface-elevated));
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
