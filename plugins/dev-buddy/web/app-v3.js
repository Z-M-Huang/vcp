/**
 * v3 modular architecture mixin for Dev Buddy config portal.
 * Handles system prompts, stages (with inline executors), pipelines, settings,
 * and system prompt import from agency-agents gallery.
 */
function v3Mixin() {
  return {
    // System Prompts
    systemPrompts: [],
    loadingSystemPrompts: false,

    async loadSystemPrompts() {
      this.loadingSystemPrompts = true;
      try {
        const resp = await fetch('/api/system-prompts');
        if (!resp.ok) { this.showError('Failed to load system prompts'); return; }
        const data = await resp.json();
        this.systemPrompts = data.prompts || [];
      } catch (e) { this.showError('Network error loading system prompts'); }
      finally { this.loadingSystemPrompts = false; }
    },

    async deleteSystemPrompt(name) {
      if (!confirm('Delete custom prompt "' + name + '"?')) return;
      try {
        const resp = await fetch('/api/system-prompts/' + encodeURIComponent(name), { method: 'DELETE' });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to delete'); return; }
        this.showSuccess('Prompt deleted: ' + name);
        await this.loadSystemPrompts();
      } catch (e) { this.showError('Network error'); }
    },

    // ============================================================
    // Stages (with inline executors + drag-and-drop)
    // ============================================================

    v3Stages: {},
    loadingStages: false,
    _execIdCounter: 0,

    async loadStages() {
      this.loadingStages = true;
      try {
        const [stagesResp] = await Promise.all([
          fetch('/api/stages'),
          this.systemPrompts.length > 0 ? Promise.resolve() : this.loadSystemPrompts(),
          this.presets && Object.keys(this.presets).length > 0 ? Promise.resolve() : this.loadPresets(),
        ]);
        if (!stagesResp.ok) { this.showError('Failed to load stages'); return; }
        const data = await stagesResp.json();

        // Prefetch model options for all presets used in stages
        const allPresets = new Set();
        for (const stage of Object.values(data.stages || {})) {
          for (const exec of (stage.executors || [])) {
            if (exec.preset) allPresets.add(exec.preset);
          }
        }
        await Promise.allSettled([...allPresets].map(p => this._fetchModelOptions(p)));

        // Assign stable _id to each executor for x-for keying
        const stages = data.stages || {};
        for (const stage of Object.values(stages)) {
          for (const exec of (stage.executors || [])) {
            exec._id = ++this._execIdCounter;
          }
        }
        this.v3Stages = stages;
      } catch (e) { this.showError('Network error loading stages'); }
      finally { this.loadingStages = false; }
    },

    async saveStage(stageType) {
      try {
        const stage = this.v3Stages[stageType];
        // Strip client-only _id field before sending to server
        const cleanExecutors = stage.executors.map(({ _id, ...rest }) => rest);
        const resp = await fetch('/api/stages/' + encodeURIComponent(stageType), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ executors: cleanExecutors }),
        });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to save'); return; }
        this.showSuccess('Stage saved: ' + stageType);
      } catch (e) { this.showError('Network error'); }
    },

    addExecutorToStage(stageType) {
      const firstPrompt = this.systemPrompts.length > 0 ? this.systemPrompts[0].name : '';
      const firstPreset = Object.keys(this.presets)[0] || '';
      if (!this.v3Stages[stageType]) this.v3Stages[stageType] = { executors: [] };
      const newExec = {
        _id: ++this._execIdCounter,
        system_prompt: firstPrompt,
        preset: firstPreset,
        model: '',
        parallel: false,
      };
      // Use spread to force Alpine reactivity (Object.entries snapshot issue)
      this.v3Stages[stageType] = {
        ...this.v3Stages[stageType],
        executors: [...this.v3Stages[stageType].executors, newExec],
      };
      if (firstPreset) this._fetchModelOptions(firstPreset);
    },

    removeExecutorFromStage(stageType, index) {
      const execs = this.v3Stages[stageType].executors.filter((_, i) => i !== index);
      // Safety: ensure last executor is non-parallel when multi-executor
      if (execs.length > 1 && execs[execs.length - 1].parallel === true) {
        execs[execs.length - 1].parallel = false;
      }
      this.v3Stages[stageType] = {
        ...this.v3Stages[stageType],
        executors: execs,
      };
    },

    async onStagePresetChange(exec) {
      exec.model = '';
      await this._fetchModelOptions(exec.preset);
    },

    // SortableJS initialization for executor rows
    initSortableExecutors(el, stageType) {
      if (el._sortableInstance) el._sortableInstance.destroy();
      el._sortableInstance = Sortable.create(el, {
        animation: 150,
        handle: '.drag-handle',
        ghostClass: 'sortable-ghost',
        filter: '.is-synthesizer',
        onMove: (evt) => {
          const execs = this.v3Stages[stageType].executors;
          if (execs.length <= 1) return true;
          // Block drops AFTER the last row (synthesizer)
          const children = [...evt.to.children].filter(c => c.classList.contains('executor-row'));
          const relatedIdx = children.indexOf(evt.related);
          if (relatedIdx === children.length - 1 && evt.willInsertAfter) return false;
          return true;
        },
        onEnd: (evt) => {
          const execs = [...this.v3Stages[stageType].executors];
          const moved = execs.splice(evt.oldIndex, 1)[0];
          execs.splice(evt.newIndex, 0, moved);
          // Safety: ensure last executor is non-parallel when multi-executor
          if (execs.length > 1 && execs[execs.length - 1].parallel === true) {
            execs[execs.length - 1].parallel = false;
          }
          this.v3Stages[stageType] = { ...this.v3Stages[stageType], executors: execs };
        },
      });
    },

    // ============================================================
    // Pipelines (v3)
    // ============================================================

    v3Pipelines: { feature_pipeline: [], bugfix_pipeline: [] },
    loadingPipelines: false,

    async loadPipelines() {
      this.loadingPipelines = true;
      try {
        const resp = await fetch('/api/pipelines');
        if (!resp.ok) { this.showError('Failed to load pipelines'); return; }
        const data = await resp.json();
        this.v3Pipelines = { feature_pipeline: data.feature_pipeline || [], bugfix_pipeline: data.bugfix_pipeline || [] };
      } catch (e) { this.showError('Network error loading pipelines'); }
      finally { this.loadingPipelines = false; }
    },

    async savePipelines() {
      try {
        const resp = await fetch('/api/pipelines', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.v3Pipelines) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to save'); return; }
        this.showSuccess('Pipelines saved');
      } catch (e) { this.showError('Network error'); }
    },

    addStageToPipeline(pipelineKey) { this.v3Pipelines[pipelineKey].push('plan-review'); },
    removeStageFromPipeline(pipelineKey, index) { this.v3Pipelines[pipelineKey].splice(index, 1); },

    moveStageInPipeline(pipelineKey, index, direction) {
      const arr = this.v3Pipelines[pipelineKey];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= arr.length) return;
      [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
    },

    // ============================================================
    // Settings
    // ============================================================

    v3Settings: { max_iterations: 10, max_tdd_iterations: 5 },
    loadingSettings: false,

    async loadSettings() {
      this.loadingSettings = true;
      try {
        const resp = await fetch('/api/settings');
        if (!resp.ok) { this.showError('Failed to load settings'); return; }
        this.v3Settings = await resp.json();
      } catch (e) { this.showError('Network error loading settings'); }
      finally { this.loadingSettings = false; }
    },

    async saveSettings() {
      try {
        const resp = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.v3Settings) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to save'); return; }
        this.showSuccess('Settings saved');
      } catch (e) { this.showError('Network error'); }
    },

    // ============================================================
    // Agency Agents Import
    // ============================================================

    showImportDialog: false,
    importLoading: false,
    importCategories: [],
    importSelectedCategory: '',
    importAgents: [],
    importSelectedAgents: {},
    importProgress: null,
    _importPrevFocus: null,

    async openImportDialog() {
      this._importPrevFocus = document.activeElement;
      this.showImportDialog = true;
      this.importSelectedCategory = '';
      this.importAgents = [];
      this.importSelectedAgents = {};
      this.importProgress = null;
      document.body.style.overflow = 'hidden';

      if (this.importCategories.length > 0) return;
      this.importLoading = true;
      try {
        const resp = await fetch('https://api.github.com/repos/msitarzewski/agency-agents/contents/');
        if (resp.status === 403) { this.showError('GitHub API rate limit exceeded. Try again later.'); this.showImportDialog = false; document.body.style.overflow = ''; return; }
        if (!resp.ok) { this.showError('Failed to load gallery categories'); return; }
        const items = await resp.json();
        this.importCategories = items
          .filter(item => item.type === 'dir' && !item.name.startsWith('.') && item.name !== 'scripts' && item.name !== 'integrations')
          .map(item => ({ name: item.name, path: item.path }));
      } catch (e) { this.showError('Network error loading gallery'); }
      finally { this.importLoading = false; }
    },

    closeImportDialog() {
      this.showImportDialog = false;
      document.body.style.overflow = '';
      if (this._importPrevFocus) {
        this._importPrevFocus.focus();
        this._importPrevFocus = null;
      }
    },

    async selectImportCategory(category) {
      this.importSelectedCategory = category;
      this.importAgents = [];
      this.importSelectedAgents = {};
      this.importLoading = true;
      try {
        const resp = await fetch('https://api.github.com/repos/msitarzewski/agency-agents/contents/' + encodeURIComponent(category));
        if (resp.status === 403) { this.showError('GitHub API rate limit exceeded.'); return; }
        if (!resp.ok) { this.showError('Failed to load agents for ' + category); return; }
        const items = await resp.json();
        this.importAgents = items
          .filter(item => item.name.endsWith('.md') && !item.name.toLowerCase().startsWith('readme'))
          .map(item => ({ name: item.name.replace('.md', ''), path: item.path, download_url: item.download_url, html_url: item.html_url }));
      } catch (e) { this.showError('Network error loading agents'); }
      finally { this.importLoading = false; }
    },

    /**
     * Convert an agency-agents markdown file to dev-buddy system prompt format.
     */
    convertAgencyAgentToPrompt(filename, rawContent) {
      let name = filename;
      let description = '';
      let tools = '';
      let body = rawContent;

      if (rawContent.startsWith('---')) {
        const endIdx = rawContent.indexOf('\n---', 3);
        if (endIdx !== -1) {
          const yamlBlock = rawContent.slice(4, endIdx).trim();
          body = rawContent.slice(endIdx + 4).trim();
          for (const line of yamlBlock.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            if (key === 'name') name = value;
            if (key === 'description') description = value;
            if (key === 'tools') tools = value;
          }
        }
      }

      // Sanitize name: lowercase, hyphens, no special chars
      const safeName = name.toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || filename.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      const safeDescription = description || (name + ' agent imported from agency-agents gallery');
      // Preserve source tools if available; default to comprehensive set for maximum flexibility
      const safeTools = tools || 'Read, Write, Edit, Glob, Grep, Bash, LSP';

      const content = [
        '---',
        'name: ' + safeName,
        'description: ' + safeDescription,
        'tools: ' + safeTools,
        '---',
        '',
        body,
      ].join('\n');

      return { name: safeName, content };
    },

    async importSelectedPrompts() {
      const selected = Object.entries(this.importSelectedAgents)
        .filter(([_, v]) => v)
        .map(([name]) => this.importAgents.find(a => a.name === name))
        .filter(Boolean);
      if (selected.length === 0) return;

      // Pre-convert all names and check for batch slug duplicates
      const converted = selected.map(agent => ({
        agent,
        ...this.convertAgencyAgentToPrompt(agent.name, ''),
      }));
      const seen = new Set();
      const deduped = [];
      for (const item of converted) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        deduped.push(item);
      }

      // Check for existing custom prompts (overwrite confirmation)
      const existingCustom = this.systemPrompts.filter(p => p.source === 'custom').map(p => p.name);
      const willOverwrite = deduped.filter(d => existingCustom.includes(d.name)).map(d => d.name);
      if (willOverwrite.length > 0) {
        if (!confirm('The following prompts already exist and will be overwritten:\n\n' + willOverwrite.join(', ') + '\n\nContinue?')) return;
      }

      this.importProgress = 'Importing 0/' + deduped.length + '...';
      let imported = 0;
      const errors = [];

      for (const item of deduped) {
        try {
          // Fetch full raw content
          const resp = await fetch(item.agent.download_url);
          if (!resp.ok) { errors.push(item.agent.name); continue; }
          const rawContent = await resp.text();
          const result = this.convertAgencyAgentToPrompt(item.agent.name, rawContent);

          const saveResp = await fetch('/api/system-prompts/' + encodeURIComponent(result.name), {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: result.content,
          });
          if (!saveResp.ok) {
            const err = await saveResp.json().catch(() => ({}));
            errors.push(item.agent.name + ': ' + (err.error?.message || 'save failed'));
            continue;
          }
          imported++;
        } catch (e) {
          errors.push(item.agent.name);
        }
        this.importProgress = 'Importing ' + imported + '/' + deduped.length + '...';
      }

      this.importProgress = null;
      this.closeImportDialog();
      if (errors.length > 0) {
        this.showError('Imported ' + imported + ', failed: ' + errors.join(', '));
      } else {
        this.showSuccess('Imported ' + imported + ' system prompt(s)');
      }
      await this.loadSystemPrompts();
    },
  };
}
