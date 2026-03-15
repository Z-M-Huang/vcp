/**
 * Chatroom config mixin for Dev Buddy config portal.
 * Handles participant management and PK Stage configuration.
 */
function chatroomMixin() {
  return {
    chatroomConfig: null,

    async loadChatroomConfig() {
      this.loading.chatroom = true;
      try {
        const [configResp, presetsResp] = await Promise.all([
          fetch('/api/chatroom-config'),
          this.presets && Object.keys(this.presets).length > 0 ? Promise.resolve(null) : fetch('/api/presets'),
          this.systemPrompts.length > 0 ? Promise.resolve() : this.loadSystemPrompts(),
        ]);
        if (!configResp.ok) { const err = await configResp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to load chatroom config'); return; }
        const data = await configResp.json();
        if (presetsResp) { const pd = await presetsResp.json(); this.presets = pd.presets || {}; }

        const participantPresets = new Set((data.config.participants || []).map(p => p.preset).filter(Boolean));
        await Promise.allSettled([...participantPresets].map(p => this._fetchModelOptions(p)));
        this.chatroomConfig = data.config;
      } catch (e) { this.showError('Network error loading chatroom config'); }
      finally { this.loading.chatroom = false; }
    },

    async saveChatroomConfig() {
      this.saving.chatroom = true;
      try {
        const payload = { participants: this.chatroomConfig.participants, max_rounds: this.chatroomConfig.max_rounds };
        const resp = await fetch('/api/chatroom-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); this.showError(err.error?.message || 'Failed to save'); return; }
        this.showSuccess('Chatroom config saved');
      } catch (e) { this.showError('Network error'); }
      finally { this.saving.chatroom = false; }
    },

    async resetChatroomToDefault() {
      if (!confirm('Reset chatroom config to factory defaults?')) return;
      try {
        const resp = await fetch('/api/chatroom-config/defaults');
        if (!resp.ok) { this.showError('Failed to load defaults'); return; }
        const data = await resp.json();
        this.chatroomConfig = data.config;
        this.showSuccess('Chatroom config reset to factory default');
      } catch (e) { this.showError('Network error'); }
    },

    addParticipant() {
      if (!this.chatroomConfig || this.chatroomConfig.participants.length >= 10) return;
      const firstPreset = Object.keys(this.presets)[0] || '';
      this.chatroomConfig.participants.push({ system_prompt: '', preset: firstPreset, model: '' });
      if (firstPreset) this._fetchModelOptions(firstPreset);
    },

    removeParticipant(index) { if (this.chatroomConfig) this.chatroomConfig.participants.splice(index, 1); },

    async onParticipantProviderChange(index) {
      if (!this.chatroomConfig) return;
      const participant = this.chatroomConfig.participants[index]; if (!participant) return;
      participant.model = ''; await this._fetchModelOptions(participant.preset);
    },
  };
}
