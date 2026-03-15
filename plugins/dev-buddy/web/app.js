/**
 * Dev Buddy Configuration Portal - Alpine.js Application
 *
 * Split into modules for maintainability:
 *   app-presets.js  — AI preset CRUD, test connectivity, key reveal, shared model helpers
 *   app-chatroom.js — Chatroom/PK Stage participant management
 *   app-v3.js       — System prompts, stages (inline executors), pipelines, settings
 *
 * Security: All dynamic content uses x-text (auto-escaped) or x-bind.
 * No innerHTML with dynamic data (AC50, XSS prevention).
 */

function devBuddyApp() {
  return {
    // Active tab
    tab: 'presets',

    // Shared UI state
    loading: { presets: false, chatroom: false },
    saving: { chatroom: false },
    errorMsg: '',
    successMsg: '',
    darkMode: false,

    // Spread all mixins
    ...presetsMixin(),
    ...chatroomMixin(),
    ...v3Mixin(),

    /**
     * Initialize the app — load presets, stage definitions, and theme.
     */
    async init() {
      this.initTheme();
      await Promise.all([
        this.loadPresets(),
        this.loadStageDefinitions(),
      ]);
    },

    /**
     * Initialize theme: apply localStorage immediately (no flash),
     * then reconcile from server config in background.
     */
    initTheme() {
      // Immediate: apply localStorage (no flash)
      const saved = localStorage.getItem('devbuddy-theme');
      this.darkMode = saved === 'dark';
      if (this.darkMode) {
        document.body.setAttribute('data-theme', 'dark');
      }
      // Background: reconcile from server config
      fetch('/api/settings').then(r => r.ok ? r.json() : null).then(settings => {
        if (settings?.theme && settings.theme !== (this.darkMode ? 'dark' : 'light')) {
          this.darkMode = settings.theme === 'dark';
          if (this.darkMode) document.body.setAttribute('data-theme', 'dark');
          else document.body.removeAttribute('data-theme');
          localStorage.setItem('devbuddy-theme', settings.theme);
        }
      }).catch(() => {});
    },

    /**
     * Toggle between light and dark themes.
     * Saves to both localStorage (instant) and server config (persistent).
     */
    toggleTheme() {
      this.darkMode = !this.darkMode;
      const theme = this.darkMode ? 'dark' : 'light';
      if (this.darkMode) {
        document.body.setAttribute('data-theme', 'dark');
      } else {
        document.body.removeAttribute('data-theme');
      }
      localStorage.setItem('devbuddy-theme', theme);
      // Keep v3Settings in sync so "Save Settings" doesn't revert theme
      if (this.v3Settings) this.v3Settings.theme = theme;
      // Fire-and-forget save to server
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      }).catch(() => {});
    },

    /**
     * Show an error message (auto-clears after 5 seconds).
     */
    showError(msg) {
      this.errorMsg = msg;
      this.successMsg = '';
      setTimeout(() => { this.errorMsg = ''; }, 5000);
    },

    /**
     * Show a success message (auto-clears after 3 seconds).
     */
    showSuccess(msg) {
      this.successMsg = msg;
      this.errorMsg = '';
      setTimeout(() => { this.successMsg = ''; }, 3000);
    },
  };
}
