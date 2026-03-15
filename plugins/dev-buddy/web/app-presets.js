/**
 * Presets management mixin for Dev Buddy config portal.
 * Handles CRUD, test connectivity, API key reveal/hide.
 */
function presetsMixin() {
  return {
    // Preset data
    presets: {},
    revealedKeys: {},
    testResults: {},
    testing: {},
    formTesting: false,
    formTestResults: null,
    showAddPreset: false,
    editingPresetKey: null,

    newPreset: {
      key: '', type: 'subscription', name: '',
      base_url: '', api_key: '', models_str: '', protocol: 'anthropic',
      reasoning_effort_api: '', max_output_tokens: '', timeout_minutes: '',
      command: '', args_template: '', resume_args_template: '', one_shot_args_template: '',
      supports_resume: false, supports_reasoning_effort: false, reasoning_effort: 'medium', cli_models_str: '',
    },

    async loadPresets() {
      this.loading.presets = true;
      try {
        const resp = await fetch('/api/presets');
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to load presets'); return; }
        const data = await resp.json();
        this.presets = data.presets || {};
      } catch (e) { this.showError('Network error loading presets'); }
      finally { this.loading.presets = false; }
    },

    async addPreset() {
      const key = this.editingPresetKey || this.newPreset.key.trim();
      if (!key) { this.showError('Preset key is required'); return; }

      let body = { name: this.newPreset.name };
      if (this.newPreset.type === 'api') {
        const models = this.newPreset.models_str ? this.newPreset.models_str.split(',').map(m => m.trim()).filter(Boolean) : [];
        body = {
          type: 'api', name: this.newPreset.name, base_url: this.newPreset.base_url,
          api_key: this.newPreset.api_key, models,
          timeout_ms: this.newPreset.timeout_minutes ? Number(this.newPreset.timeout_minutes) * 60000 : undefined,
          protocol: this.newPreset.protocol || 'anthropic',
          reasoning_effort: this.newPreset.protocol === 'openai' && this.newPreset.reasoning_effort_api ? this.newPreset.reasoning_effort_api : undefined,
          max_output_tokens: this.newPreset.protocol === 'openai' && this.newPreset.max_output_tokens ? Number(this.newPreset.max_output_tokens) : undefined,
        };
      } else if (this.newPreset.type === 'subscription') {
        body = { type: 'subscription', name: this.newPreset.name };
      } else if (this.newPreset.type === 'cli') {
        const models = this.newPreset.cli_models_str ? this.newPreset.cli_models_str.split(',').map(m => m.trim()).filter(Boolean) : [];
        body = {
          type: 'cli', name: this.newPreset.name, command: this.newPreset.command,
          args_template: this.newPreset.args_template,
          resume_args_template: this.newPreset.resume_args_template || undefined,
          one_shot_args_template: this.newPreset.one_shot_args_template || undefined,
          supports_resume: this.newPreset.supports_resume || undefined,
          supports_reasoning_effort: this.newPreset.supports_reasoning_effort || undefined,
          reasoning_effort: this.newPreset.supports_reasoning_effort ? this.newPreset.reasoning_effort : undefined,
          timeout_ms: this.newPreset.timeout_minutes ? Number(this.newPreset.timeout_minutes) * 60000 : undefined,
          models,
        };
      }

      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to add preset'); return; }
        this.showSuccess((this.editingPresetKey ? 'Updated: ' : 'Added: ') + key);
        this.editingPresetKey = null; this.showAddPreset = false; this.resetNewPreset();
        await this.loadPresets();
      } catch (e) { this.showError('Network error adding preset'); }
    },

    async deletePreset(name) {
      if (!confirm('Remove preset "' + name + '"?')) return;
      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to delete'); return; }
        this.showSuccess('Removed: ' + name); delete this.revealedKeys[name]; await this.loadPresets();
      } catch (e) { this.showError('Network error'); }
    },

    async revealKey(presetName) {
      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(presetName)}?reveal=true`);
        if (resp.status === 429) { this.showError('Rate limit exceeded'); return; }
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to reveal'); return; }
        const data = await resp.json();
        this.revealedKeys[presetName] = data.preset?.api_key || '';
      } catch (e) { this.showError('Network error'); }
    },

    hideKey(presetName) { delete this.revealedKeys[presetName]; },

    async testPreset(name) {
      this.testing = { ...this.testing, [name]: true };
      this.testResults = { ...this.testResults, [name]: null };
      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(name)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (resp.status === 429) { this.showError('Test rate limit exceeded'); return; }
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Test failed'); return; }
        this.testResults = { ...this.testResults, [name]: await resp.json() };
      } catch (e) { this.showError('Network error'); }
      finally { this.testing = { ...this.testing, [name]: false }; }
    },

    dismissTest(name) { this.testResults = { ...this.testResults, [name]: null }; },

    async editPreset(name) {
      const preset = this.presets[name];
      if (!preset) return;
      this.newPreset.key = name; this.newPreset.type = preset.type; this.newPreset.name = preset.name;
      if (preset.type === 'api') {
        this.newPreset.base_url = preset.base_url || '';
        try { const resp = await fetch(`/api/presets/${encodeURIComponent(name)}?reveal=true`); if (resp.ok) { const data = await resp.json(); this.newPreset.api_key = data.preset?.api_key || ''; } else { this.newPreset.api_key = ''; } } catch { this.newPreset.api_key = ''; }
        this.newPreset.models_str = Array.isArray(preset.models) ? preset.models.join(', ') : '';
        this.newPreset.timeout_minutes = preset.timeout_ms ? String(Math.round(preset.timeout_ms / 60000)) : '';
        this.newPreset.protocol = preset.protocol || 'anthropic';
        this.newPreset.reasoning_effort_api = preset.reasoning_effort || '';
        this.newPreset.max_output_tokens = preset.max_output_tokens || '';
      } else if (preset.type === 'cli') {
        this.newPreset.command = preset.command || ''; this.newPreset.args_template = preset.args_template || '';
        this.newPreset.resume_args_template = preset.resume_args_template || '';
        this.newPreset.one_shot_args_template = preset.one_shot_args_template || '';
        this.newPreset.supports_resume = preset.supports_resume || false;
        this.newPreset.supports_reasoning_effort = preset.supports_reasoning_effort || false;
        this.newPreset.reasoning_effort = preset.reasoning_effort || 'medium';
        this.newPreset.timeout_minutes = preset.timeout_ms ? String(Math.round(preset.timeout_ms / 60000)) : '';
        this.newPreset.cli_models_str = Array.isArray(preset.models) ? preset.models.join(', ') : '';
      }
      this.editingPresetKey = name; this.showAddPreset = true;
    },

    canTestFormPreset() {
      if (this.formTesting) return false;
      if (this.newPreset.type === 'api') { return this.newPreset.base_url.trim().length > 0 && this.newPreset.api_key.trim().length > 0 && this.newPreset.models_str.split(',').filter(m => m.trim()).length > 0; }
      if (this.newPreset.type === 'cli') { return this.newPreset.command.trim().length > 0; }
      return false;
    },

    async testFormPreset() {
      this.formTesting = true; this.formTestResults = null;
      try {
        const body = { type: this.newPreset.type };
        if (this.newPreset.type === 'api') { body.base_url = this.newPreset.base_url; body.api_key = this.newPreset.api_key; body.models = this.newPreset.models_str.split(',').map(m => m.trim()).filter(Boolean); body.protocol = this.newPreset.protocol || 'anthropic'; if (this.newPreset.protocol === 'openai' && this.newPreset.max_output_tokens) body.max_output_tokens = Number(this.newPreset.max_output_tokens); }
        else if (this.newPreset.type === 'cli') { body.command = this.newPreset.command; }
        const resp = await fetch('/api/test-preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await resp.json();
        this.formTestResults = (!resp.ok && data.error) ? { type: 'error', message: data.error.message || 'Test failed' } : data;
      } catch (err) { this.formTestResults = { type: 'error', message: 'Network error' }; }
      finally { this.formTesting = false; }
    },

    resetNewPreset() {
      this.editingPresetKey = null; this.formTesting = false; this.formTestResults = null;
      this.newPreset = { key: '', type: 'subscription', name: '', base_url: '', api_key: '', models_str: '', protocol: 'anthropic', reasoning_effort_api: '', max_output_tokens: '', timeout_minutes: '', command: '', args_template: '', resume_args_template: '', one_shot_args_template: '', supports_resume: false, supports_reasoning_effort: false, reasoning_effort: 'medium', cli_models_str: '' };
    },

    // ============================================================
    // Shared: Model Options + Stage Definitions (moved from v2 pipeline mixin)
    // ============================================================

    stageDefinitions: {},
    stageModelOptions: {},

    async loadStageDefinitions() {
      try {
        const resp = await fetch('/api/stage-definitions');
        if (!resp.ok) return;
        const data = await resp.json();
        this.stageDefinitions = data.stage_definitions || {};
      } catch (e) { /* Non-fatal */ }
    },

    async _fetchModelOptions(providerName) {
      if (!providerName || this.stageModelOptions[providerName] !== undefined) return;
      try {
        const resp = await fetch(`/api/preset-models/${encodeURIComponent(providerName)}`);
        if (!resp.ok) { this.stageModelOptions = { ...this.stageModelOptions, [providerName]: [] }; return; }
        const data = await resp.json();
        this.stageModelOptions = { ...this.stageModelOptions, [providerName]: data.models || [] };
      } catch (e) { this.stageModelOptions = { ...this.stageModelOptions, [providerName]: [] }; }
    },

    async onProviderChange(stage) {
      if (stage.model !== undefined) stage.model = undefined;
      await this._fetchModelOptions(stage.provider);
    },
  };
}
