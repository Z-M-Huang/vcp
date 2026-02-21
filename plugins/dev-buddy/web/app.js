/**
 * Dev Buddy Configuration Portal - Alpine.js Application
 *
 * Security: All dynamic content uses x-text (auto-escaped) or x-bind.
 * No innerHTML with dynamic data (AC50, XSS prevention).
 */

function devBuddyApp() {
  return {
    // Current active tab
    tab: 'presets',

    // Data
    presets: {},
    pipelineConfig: null,
    sessions: [],

    // Reveal state (client-side only, no server call to hide)
    revealedKeys: {},

    // UI state
    loading: { presets: false, pipeline: false, sessions: false },
    saving: { pipeline: false },
    errorMsg: '',
    successMsg: '',
    showAddPreset: false,

    // New preset form state
    newPreset: {
      key: '',
      type: 'subscription',
      name: '',
      description: '',
      base_url: '',
      api_key: '',
      models_str: '',
      command: '',
      args_str: '',
    },

    // Pipeline stage definitions (display order and labels)
    pipelineStages: [
      { key: 'requirements', label: 'Requirements Gathering' },
      { key: 'planning', label: 'Planning' },
      { key: 'plan_review_sonnet', label: 'Plan Review (Sonnet)' },
      { key: 'plan_review_opus', label: 'Plan Review (Opus)' },
      { key: 'plan_review_codex', label: 'Plan Review (Codex)' },
      { key: 'implementation', label: 'Implementation' },
      { key: 'code_review_sonnet', label: 'Code Review (Sonnet)' },
      { key: 'code_review_opus', label: 'Code Review (Opus)' },
      { key: 'code_review_codex', label: 'Code Review (Codex)' },
    ],

    // Session polling interval
    sessionPollInterval: null,

    /**
     * Initialize the app
     */
    async init() {
      await this.loadPresets();
    },

    /**
     * Show an error message (auto-clears after 5 seconds)
     */
    showError(msg) {
      this.errorMsg = msg;
      this.successMsg = '';
      setTimeout(() => { this.errorMsg = ''; }, 5000);
    },

    /**
     * Show a success message (auto-clears after 3 seconds)
     */
    showSuccess(msg) {
      this.successMsg = msg;
      this.errorMsg = '';
      setTimeout(() => { this.successMsg = ''; }, 3000);
    },

    // ============================================================
    // Presets
    // ============================================================

    /**
     * Load all presets from the REST API.
     */
    async loadPresets() {
      this.loading.presets = true;
      try {
        const resp = await fetch('/api/presets');
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to load presets');
          return;
        }
        const data = await resp.json();
        this.presets = data.presets || {};
      } catch (e) {
        this.showError('Network error loading presets');
      } finally {
        this.loading.presets = false;
      }
    },

    /**
     * Add a new preset via the REST API.
     */
    async addPreset() {
      const key = this.newPreset.key.trim();
      if (!key) {
        this.showError('Preset key is required');
        return;
      }

      // Build preset body based on type
      let body = { name: this.newPreset.name };
      if (this.newPreset.type === 'api') {
        const models = this.newPreset.models_str
          ? this.newPreset.models_str.split(',').map(m => m.trim()).filter(Boolean)
          : [];
        body = {
          type: 'api',
          name: this.newPreset.name,
          description: this.newPreset.description || undefined,
          base_url: this.newPreset.base_url,
          api_key: this.newPreset.api_key,
          models,
        };
      } else if (this.newPreset.type === 'subscription') {
        body = {
          type: 'subscription',
          name: this.newPreset.name,
          description: this.newPreset.description || undefined,
        };
      } else if (this.newPreset.type === 'cli') {
        const args = this.newPreset.args_str
          ? this.newPreset.args_str.split(',').map(a => a.trim()).filter(Boolean)
          : undefined;
        body = {
          type: 'cli',
          name: this.newPreset.name,
          description: this.newPreset.description || undefined,
          command: this.newPreset.command,
          args,
        };
      }

      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to add preset');
          return;
        }
        this.showSuccess('Preset added: ' + key);
        this.showAddPreset = false;
        this.resetNewPreset();
        await this.loadPresets();
      } catch (e) {
        this.showError('Network error adding preset');
      }
    },

    /**
     * Delete a preset.
     */
    async deletePreset(name) {
      if (!confirm('Remove preset "' + name + '"?')) return;
      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to delete preset');
          return;
        }
        this.showSuccess('Preset removed: ' + name);
        delete this.revealedKeys[name];
        await this.loadPresets();
      } catch (e) {
        this.showError('Network error deleting preset');
      }
    },

    /**
     * Reveal the full API key for a preset.
     * Calls GET /api/presets/:name?reveal=true
     */
    async revealKey(presetName) {
      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(presetName)}?reveal=true`);
        if (resp.status === 429) {
          this.showError('Rate limit exceeded. Please wait before revealing again.');
          return;
        }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to reveal key');
          return;
        }
        const data = await resp.json();
        // Store revealed key client-side only — never sent back to server
        this.revealedKeys[presetName] = data.preset?.api_key || '';
      } catch (e) {
        this.showError('Network error revealing key');
      }
    },

    /**
     * Hide a revealed API key (client-side only, no server call).
     */
    hideKey(presetName) {
      delete this.revealedKeys[presetName];
    },

    /**
     * Reset the add preset form.
     */
    resetNewPreset() {
      this.newPreset = {
        key: '',
        type: 'subscription',
        name: '',
        description: '',
        base_url: '',
        api_key: '',
        models_str: '',
        command: '',
        args_str: '',
      };
    },

    // ============================================================
    // Pipeline Config
    // ============================================================

    /**
     * Load pipeline config from REST API.
     */
    async loadPipelineConfig() {
      this.loading.pipeline = true;
      try {
        // Load pipeline config and presets together
        const [configResp, presetsResp] = await Promise.all([
          fetch('/api/pipeline-config'),
          this.presets && Object.keys(this.presets).length > 0
            ? Promise.resolve(null)
            : fetch('/api/presets'),
        ]);

        if (!configResp.ok) {
          const err = await configResp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to load pipeline config');
          return;
        }

        const data = await configResp.json();
        this.pipelineConfig = data.config;

        if (presetsResp) {
          const presetsData = await presetsResp.json();
          this.presets = presetsData.presets || {};
        }
      } catch (e) {
        this.showError('Network error loading pipeline config');
      } finally {
        this.loading.pipeline = false;
      }
    },

    /**
     * Save pipeline config via REST API.
     */
    async savePipelineConfig() {
      this.saving.pipeline = true;
      try {
        const resp = await fetch('/api/pipeline-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.pipelineConfig),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to save pipeline config');
          return;
        }
        this.showSuccess('Pipeline config saved');
      } catch (e) {
        this.showError('Network error saving pipeline config');
      } finally {
        this.saving.pipeline = false;
      }
    },

    // ============================================================
    // Sessions
    // ============================================================

    /**
     * Load session manager status.
     */
    async loadSessions() {
      this.loading.sessions = true;
      try {
        const resp = await fetch('/api/sessions');
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Request failed' } }));
          this.showError(err.error?.message || 'Failed to load sessions');
          return;
        }
        const data = await resp.json();
        this.sessions = data.sessions || [];
      } catch (e) {
        this.showError('Network error loading sessions');
      } finally {
        this.loading.sessions = false;
      }
    },

    /**
     * Start auto-polling session status every 10 seconds.
     */
    startSessionPolling() {
      if (this.sessionPollInterval !== null) return;
      this.sessionPollInterval = setInterval(() => this.loadSessions(), 10000);
    },

    /**
     * Stop auto-polling session status and clear the interval.
     */
    stopSessionPolling() {
      if (this.sessionPollInterval !== null) {
        clearInterval(this.sessionPollInterval);
        this.sessionPollInterval = null;
      }
    },

    /**
     * Format uptime milliseconds to human-readable string.
     */
    formatUptime(ms) {
      if (ms === undefined || ms === null) return 'N/A';
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
      if (minutes > 0) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    },
  };
}
