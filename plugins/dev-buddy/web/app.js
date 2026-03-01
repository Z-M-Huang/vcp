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

    // Pipeline sub-tab ('feature' | 'bugfix')
    pipelineSubTab: 'feature',

    // Data
    presets: {},
    pipelineConfig: null,
    stageDefinitions: {},

    // Model options per provider (populated via GET /api/preset-models/:name)
    stageModelOptions: {},

    // New stage type selection per pipeline
    newStageType: { feature: '', bugfix: '' },

    // SortableJS instances
    _sortableInstances: {},

    // Counter for generating stable stage IDs (used as x-for keys)
    _stageIdCounter: 0,

    // Reveal state (client-side only, no server call to hide)
    revealedKeys: {},

    // Test connectivity results (keyed by preset name, ephemeral)
    testResults: {},
    testing: {},

    // In-form test state (for add/edit form)
    formTesting: false,
    formTestResults: null,

    // UI state
    loading: { presets: false, pipeline: false },
    saving: { pipeline: false },
    errorMsg: '',
    successMsg: '',
    showAddPreset: false,
    editingPresetKey: null,

    // New preset form state
    newPreset: {
      key: '',
      type: 'subscription',
      name: '',
      base_url: '',
      api_key: '',
      models_str: '',
      command: '',
      args_template: '',
      resume_args_template: '',
      one_shot_args_template: '',
      supports_resume: false,
      supports_reasoning_effort: false,
      reasoning_effort: 'medium',
      timeout_minutes: '',
      cli_models_str: '',
    },

    /**
     * Initialize the app
     */
    async init() {
      await Promise.all([
        this.loadPresets(),
        this.loadStageDefinitions(),
      ]);
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
      const key = this.editingPresetKey || this.newPreset.key.trim();
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
          base_url: this.newPreset.base_url,
          api_key: this.newPreset.api_key,
          models,
          timeout_ms: this.newPreset.timeout_minutes ? Number(this.newPreset.timeout_minutes) * 60000 : undefined,
        };
      } else if (this.newPreset.type === 'subscription') {
        body = {
          type: 'subscription',
          name: this.newPreset.name,
        };
      } else if (this.newPreset.type === 'cli') {
        const models = this.newPreset.cli_models_str
          ? this.newPreset.cli_models_str.split(',').map(m => m.trim()).filter(Boolean)
          : [];
        body = {
          type: 'cli',
          name: this.newPreset.name,
          command: this.newPreset.command,
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
        this.showSuccess((this.editingPresetKey ? 'Preset updated: ' : 'Preset added: ') + key);
        this.editingPresetKey = null;
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
     * Test preset connectivity via POST /api/presets/:name/test.
     * Results stored in testResults[name] with spread-and-reassign for reactivity.
     */
    async testPreset(name) {
      // Set testing state (prevents double-click)
      this.testing = { ...this.testing, [name]: true };
      // Clear previous results
      this.testResults = { ...this.testResults, [name]: null };
      try {
        const resp = await fetch(`/api/presets/${encodeURIComponent(name)}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.status === 429) {
          const err = await resp.json().catch(() => ({ error: { message: 'Rate limit exceeded' } }));
          this.showError(err.error?.message || 'Test rate limit exceeded');
          return;
        }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: 'Test request failed' } }));
          this.showError(err.error?.message || 'Test failed');
          return;
        }
        const data = await resp.json();
        this.testResults = { ...this.testResults, [name]: data };
      } catch (e) {
        this.showError('Network error testing preset');
      } finally {
        this.testing = { ...this.testing, [name]: false };
      }
    },

    /**
     * Dismiss test results for a preset.
     */
    dismissTest(name) {
      this.testResults = { ...this.testResults, [name]: null };
    },

    /**
     * Populate the add-preset form from an existing preset and open in edit mode.
     */
    async editPreset(name) {
      const preset = this.presets[name];
      if (!preset) return;

      this.newPreset.key = name;
      this.newPreset.type = preset.type;
      this.newPreset.name = preset.name;

      if (preset.type === 'api') {
        this.newPreset.base_url = preset.base_url || '';
        try {
          const resp = await fetch(`/api/presets/${encodeURIComponent(name)}?reveal=true`);
          if (resp.ok) {
            const data = await resp.json();
            this.newPreset.api_key = data.preset?.api_key || '';
          } else {
            this.newPreset.api_key = '';
          }
        } catch {
          this.newPreset.api_key = '';
        }
        this.newPreset.models_str = Array.isArray(preset.models) ? preset.models.join(', ') : '';
        this.newPreset.timeout_minutes = preset.timeout_ms ? String(Math.round(preset.timeout_ms / 60000)) : '';
      } else if (preset.type === 'cli') {
        this.newPreset.command = preset.command || '';
        this.newPreset.args_template = preset.args_template || '';
        this.newPreset.resume_args_template = preset.resume_args_template || '';
        this.newPreset.one_shot_args_template = preset.one_shot_args_template || '';
        this.newPreset.supports_resume = preset.supports_resume || false;
        this.newPreset.supports_reasoning_effort = preset.supports_reasoning_effort || false;
        this.newPreset.reasoning_effort = preset.reasoning_effort || 'medium';
        this.newPreset.timeout_minutes = preset.timeout_ms ? String(Math.round(preset.timeout_ms / 60000)) : '';
        this.newPreset.cli_models_str = Array.isArray(preset.models) ? preset.models.join(', ') : '';
      }

      this.editingPresetKey = name;
      this.showAddPreset = true;
    },

    /**
     * Check if the in-form test button should be enabled.
     */
    canTestFormPreset() {
      if (this.formTesting) return false;
      if (this.newPreset.type === 'api') {
        const hasUrl = this.newPreset.base_url.trim().length > 0;
        const hasKey = this.newPreset.api_key.trim().length > 0;
        const models = this.newPreset.models_str.split(',').map(m => m.trim()).filter(Boolean);
        return hasUrl && hasKey && models.length > 0;
      }
      if (this.newPreset.type === 'cli') {
        return this.newPreset.command.trim().length > 0;
      }
      return false;
    },

    /**
     * Test connectivity from the add/edit form using unsaved credentials.
     * Calls POST /api/test-preset with form data.
     */
    async testFormPreset() {
      this.formTesting = true;
      this.formTestResults = null;
      try {
        const body = { type: this.newPreset.type };
        if (this.newPreset.type === 'api') {
          body.base_url = this.newPreset.base_url;
          body.api_key = this.newPreset.api_key;
          body.models = this.newPreset.models_str.split(',').map(m => m.trim()).filter(Boolean);
        } else if (this.newPreset.type === 'cli') {
          body.command = this.newPreset.command;
        }
        const resp = await fetch('/api/test-preset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok && data.error) {
          this.formTestResults = { type: 'error', message: data.error.message || 'Test failed' };
        } else {
          this.formTestResults = data;
        }
      } catch (err) {
        this.formTestResults = { type: 'error', message: 'Network error' };
      } finally {
        this.formTesting = false;
      }
    },

    resetNewPreset() {
      this.editingPresetKey = null;
      this.formTesting = false;
      this.formTestResults = null;
      this.newPreset = {
        key: '',
        type: 'subscription',
        name: '',
        base_url: '',
        api_key: '',
        models_str: '',
        command: '',
        args_template: '',
        resume_args_template: '',
        one_shot_args_template: '',
        supports_resume: false,
        supports_reasoning_effort: false,
        reasoning_effort: 'medium',
        timeout_minutes: '',
        cli_models_str: '',
      };
    },

    // ============================================================
    // Stage Definitions
    // ============================================================

    /**
     * Load stage definitions from the REST API.
     */
    async loadStageDefinitions() {
      try {
        const resp = await fetch('/api/stage-definitions');
        if (!resp.ok) return;
        const data = await resp.json();
        this.stageDefinitions = data.stage_definitions || {};
      } catch (e) {
        // Non-fatal — stage definitions are best-effort for UI
      }
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

        if (presetsResp) {
          const presetsData = await presetsResp.json();
          this.presets = presetsData.presets || {};
        }

        // Pre-load model options BEFORE assigning config — otherwise Alpine
        // renders <select> with empty options, x-model clears the saved value.
        const pipelines = [
          ...(data.config.feature_pipeline || []),
          ...(data.config.bugfix_pipeline || []),
        ];
        const uniqueProviders = [...new Set(pipelines.map(s => s.provider).filter(Boolean))];
        await Promise.allSettled(uniqueProviders.map(p => this._fetchModelOptions(p)));

        // Now assign config — Alpine renders selects with options already present
        this.pipelineConfig = data.config;
        this._assignStageIds(this.pipelineConfig.feature_pipeline);
        this._assignStageIds(this.pipelineConfig.bugfix_pipeline);

        // Init sortable after DOM renders
        this.$nextTick(() => {
          this.initSortable('feature-pipeline-list');
        });
      } catch (e) {
        this.showError('Network error loading pipeline config');
      } finally {
        this.loading.pipeline = false;
      }
    },

    /**
     * Fetch and cache model options for a provider.
     */
    async _fetchModelOptions(providerName) {
      if (!providerName || this.stageModelOptions[providerName] !== undefined) return;
      try {
        const resp = await fetch(`/api/preset-models/${encodeURIComponent(providerName)}`);
        if (!resp.ok) {
          this.stageModelOptions = { ...this.stageModelOptions, [providerName]: [] };
          return;
        }
        const data = await resp.json();
        this.stageModelOptions = { ...this.stageModelOptions, [providerName]: data.models || [] };
      } catch (e) {
        this.stageModelOptions = { ...this.stageModelOptions, [providerName]: [] };
      }
    },

    /**
     * Called when a stage's provider changes — fetch model options for the new provider.
     */
    async onProviderChange(stage) {
      if (stage.model !== undefined) {
        stage.model = undefined;
      }
      await this._fetchModelOptions(stage.provider);
    },

    /**
     * Stamp each stage with a non-enumerable _id for stable x-for keys.
     * Non-enumerable so JSON.stringify() omits it (server rejects unknown fields).
     */
    _assignStageIds(pipeline) {
      for (const stage of pipeline) {
        if (!Object.prototype.hasOwnProperty.call(stage, '_id')) {
          Object.defineProperty(stage, '_id', {
            value: ++this._stageIdCounter,
            writable: true,
            enumerable: false,
            configurable: true,
          });
        }
      }
    },

    /**
     * Initialize SortableJS on a pipeline list container.
     * Syncs DOM reorder back to Alpine data array.
     */
    initSortable(containerId) {
      // Destroy existing instance for this container (sub-tab switch)
      if (this._sortableInstances[containerId]) {
        this._sortableInstances[containerId].destroy();
        delete this._sortableInstances[containerId];
      }

      const el = document.getElementById(containerId);
      if (!el || typeof Sortable === 'undefined') return;

      const pipelineType = containerId === 'feature-pipeline-list' ? 'feature' : 'bugfix';
      const self = this;

      this._sortableInstances[containerId] = Sortable.create(el, {
        animation: 150,
        handle: '.drag-handle',
        ghostClass: 'ghost',
        onEnd(evt) {
          const oldIndex = evt.oldIndex;
          const newIndex = evt.newIndex;
          if (oldIndex === newIndex) return;

          // Revert SortableJS's DOM mutation — let Alpine own rendering exclusively.
          // SortableJS skips <template> elements in its index calculation, but
          // parent.children includes Alpine's <template x-for> at index 0.
          // Remove the item first, then re-insert at oldIndex among stage cards.
          const parent = evt.from;
          evt.item.remove();
          const cards = parent.querySelectorAll(':scope > .stage-card');
          if (oldIndex >= cards.length) {
            parent.appendChild(evt.item);
          } else {
            parent.insertBefore(evt.item, cards[oldIndex]);
          }

          // Now update data — Alpine handles DOM rendering
          const pipeline = pipelineType === 'feature'
            ? self.pipelineConfig.feature_pipeline
            : self.pipelineConfig.bugfix_pipeline;

          if (oldIndex < 0 || oldIndex >= pipeline.length || newIndex < 0 || newIndex >= pipeline.length) return;

          const moved = pipeline.splice(oldIndex, 1)[0];
          pipeline.splice(newIndex, 0, moved);
        },
      });
    },

    /**
     * Returns stage types that can be added to the given pipeline type,
     * filtered by singleton constraint and allowed_pipelines.
     */
    getAvailableStageTypes(pipelineType) {
      const pipeline = pipelineType === 'feature'
        ? (this.pipelineConfig?.feature_pipeline || [])
        : (this.pipelineConfig?.bugfix_pipeline || []);

      const currentTypes = pipeline.map(s => s.type);

      return Object.entries(this.stageDefinitions)
        .filter(([type, def]) => {
          // Filter by pipeline type restriction
          if (!def.allowed_pipelines.includes(pipelineType)) return false;
          // Filter out singletons already present
          if (def.singleton && currentTypes.includes(type)) return false;
          return true;
        })
        .map(([type]) => type);
    },

    /**
     * Add a new stage of the given type to the pipeline.
     */
    addStage(pipelineType, stageType) {
      if (!stageType) return;

      const pipeline = pipelineType === 'feature'
        ? this.pipelineConfig.feature_pipeline
        : this.pipelineConfig.bugfix_pipeline;

      // Find first available provider (default to first preset key)
      const firstPreset = Object.keys(this.presets)[0] || 'anthropic-subscription';

      pipeline.push({ type: stageType, provider: firstPreset, model: undefined });
      this._assignStageIds(pipeline);

      // Reset the "add stage" select
      this.newStageType[pipelineType] = '';

      // Re-init sortable after DOM update
      this.$nextTick(() => {
        this.initSortable(pipelineType === 'feature' ? 'feature-pipeline-list' : 'bugfix-pipeline-list');
      });
    },

    /**
     * Remove the stage at the given index from the pipeline.
     * Validates that at least 1 implementation stage remains.
     */
    removeStage(pipelineType, index) {
      const pipeline = pipelineType === 'feature'
        ? this.pipelineConfig.feature_pipeline
        : this.pipelineConfig.bugfix_pipeline;

      // Validate: must keep at least 1 implementation stage
      const stage = pipeline[index];
      if (stage && stage.type === 'implementation') {
        const implCount = pipeline.filter(s => s.type === 'implementation').length;
        if (implCount <= 1) {
          this.showError('Cannot remove the last implementation stage');
          return;
        }
      }

      pipeline.splice(index, 1);

      // Re-init sortable after DOM update
      this.$nextTick(() => {
        this.initSortable(pipelineType === 'feature' ? 'feature-pipeline-list' : 'bugfix-pipeline-list');
      });
    },

    /**
     * Reset one pipeline to the factory default config.
     *
     * Fetches GET /api/pipeline-config/defaults which always returns the
     * hard-coded DEFAULT_CONFIG (not the user-saved config from disk).
     * Only the specified pipeline array is replaced so that unsaved changes
     * to the other pipeline are preserved.
     */
    async resetToDefault(pipelineType) {
      const label = pipelineType === 'feature' ? 'Feature Pipeline' : 'Bug-Fix Pipeline';
      if (!confirm('Reset ' + label + ' to the factory default configuration? This will clear any changes to this pipeline.')) return;

      try {
        const resp = await fetch('/api/pipeline-config/defaults');
        if (!resp.ok) {
          this.showError('Failed to load factory default config');
          return;
        }
        const data = await resp.json();
        const defaultConfig = data.config;

        // Replace only the specified pipeline array — leave the other pipeline
        // and settings (max_iterations, team_name_pattern) untouched.
        if (pipelineType === 'feature') {
          this.pipelineConfig.feature_pipeline = defaultConfig.feature_pipeline;
          this._assignStageIds(this.pipelineConfig.feature_pipeline);
        } else {
          this.pipelineConfig.bugfix_pipeline = defaultConfig.bugfix_pipeline;
          this._assignStageIds(this.pipelineConfig.bugfix_pipeline);
        }

        // Re-initialise sortable for the affected list after the DOM updates
        this.$nextTick(() => {
          this.initSortable(pipelineType === 'feature' ? 'feature-pipeline-list' : 'bugfix-pipeline-list');
        });

        this.showSuccess(label + ' reset to factory default');
      } catch (e) {
        this.showError('Network error resetting config');
      }
    },

    /**
     * Save pipeline config via REST API.
     */
    async savePipelineConfig() {
      this.saving.pipeline = true;
      try {
        const payload = {
          feature_pipeline: this.pipelineConfig.feature_pipeline,
          bugfix_pipeline: this.pipelineConfig.bugfix_pipeline,
          max_iterations: this.pipelineConfig.max_iterations,
          team_name_pattern: this.pipelineConfig.team_name_pattern,
        };

        const resp = await fetch('/api/pipeline-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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
  };
}
