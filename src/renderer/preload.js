const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload Script] Initializing preload script for main world exposure.');

contextBridge.exposeInMainWorld('electronAPI', {
  // ---- IPC 相关函数 ----
  onNotificationData: (callback) => {
    ipcRenderer.on('notification-data', (event, data) => callback(data));
  },
  onNotificationClose: (callback) => {
    ipcRenderer.on('notification-close', () => callback());
  },
  notifyMouseEnter: (id) => {
    ipcRenderer.send('notification-mouse-enter', id);
  },
  notifyMouseLeave: (id) => {
    ipcRenderer.send('notification-mouse-leave', id);
  },
  requestResize: (id, height) => {
    ipcRenderer.send('resize-notification', { id, height });
  },

  // ---- 调用主进程的 Markdown 渲染服务 ----
  renderMarkdown: async (markdownContent) => {
    try {
      const html = await ipcRenderer.invoke('render-markdown-to-html', markdownContent);
      return html;
    } catch (error) {
      console.error('[Preload Script] Error invoking render-markdown-to-html:', error);
      const escapedContent = (typeof markdownContent === 'string')
        ? markdownContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : "Invalid content";
      return `<p style="color: red;">Error communicating with main process for rendering: ${error.message}</p><pre>${escapedContent}</pre>`;
    }
  },

  // ---- 用户手动关闭通知时，通知主进程 ----
  requestManualClose: (notificationId) => {
    console.log(`[Preload Script] Sending user-close-notification for ID: ${notificationId}`);
    ipcRenderer.send('user-close-notification', notificationId);
  },

  // ---- 新增：监听主题变化 ----
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (event, actualTheme) => callback(actualTheme));
  }
});

console.log('[Preload Script] Electron APIs exposed on window.electronAPI.');