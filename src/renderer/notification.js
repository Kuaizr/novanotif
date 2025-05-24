// At the very top
console.log('[NotificationRenderer] notification.js script started execution.');

let notificationData = null;
let container = null;
let titleElement = null;
let contentElement = null;
let closeButton = null;
// let currentTheme = 'light'; // To store the current theme, initialized by data or default

function applyTheme(theme) { // theme is 'light' or 'dark'
  console.log(`[NotificationRenderer] Applying theme: ${theme}`);
  document.body.classList.remove('theme-light', 'theme-dark');
  if (theme === 'dark') {
    document.body.classList.add('theme-dark');
  } else {
    document.body.classList.add('theme-light');
  }
  // currentTheme = theme;
}

function initialize() {
  console.log('[NotificationRenderer] Initialize function called.');
  container = document.querySelector('.notification-container');
  titleElement = document.querySelector('.notification-title');
  contentElement = document.querySelector('.notification-content');
  closeButton = document.querySelector('.notification-close-btn');

  if (!container || !titleElement || !contentElement || !closeButton) {
    console.error('[NotificationRenderer] Failed to select one or more DOM elements:',
      { container, titleElement, contentElement, closeButton });
    if (document.body) {
        document.body.innerHTML = '<p style="color:red; padding:10px;">Notification UI elements missing. Cannot initialize.</p>';
    }
    return;
  }
  console.log('[NotificationRenderer] DOM elements selected successfully.');
  setupEventListeners();
}

function setupEventListeners() {
  console.log('[NotificationRenderer] setupEventListeners called.');
  if (!window.electronAPI) {
    console.error('[NotificationRenderer] FATAL: window.electronAPI is not defined. Preload script did not execute correctly or was blocked.');
    if (contentElement) contentElement.innerHTML = '<p style="color:red;">错误：无法初始化渲染器API (electronAPI 未定义)。</p>';
    else if (document.body) document.body.innerHTML = '<p style="color:red;">错误：无法初始化渲染器API (electronAPI 未定义)。</p>';
    return;
  }

  window.electronAPI.onNotificationData(async (data) => {
    notificationData = data;
    if (!data || typeof data.id === 'undefined') {
        console.error('[NotificationRenderer] Received invalid notification data from main process:', data);
        if (contentElement) contentElement.innerHTML = '<p style="color:red;">收到无效的通知数据。</p>';
        return;
    }
    // Apply initial theme received with data
    if (data.actualTheme) {
      applyTheme(data.actualTheme);
    } else {
      applyTheme('light'); // Fallback if not provided, though it should be
    }
    await renderNotification(data);
  });

  window.electronAPI.onNotificationClose(() => {
    closeNotification();
  });

  // Listen for theme changes from main process
  window.electronAPI.onThemeChanged((actualTheme) => {
    console.log('[NotificationRenderer] Received theme-changed event, new theme:', actualTheme);
    applyTheme(actualTheme);
  });

  if (!container) {
    console.error("[NotificationRenderer] setupEventListeners: container is null after DOM selection. Cannot add mouse event listeners.");
    return;
  }
  container.addEventListener('mouseenter', () => {
    if (notificationData && window.electronAPI && window.electronAPI.notifyMouseEnter) {
      window.electronAPI.notifyMouseEnter(notificationData.id);
    }
  });
  container.addEventListener('mouseleave', () => {
    if (notificationData && window.electronAPI && window.electronAPI.notifyMouseLeave) {
      window.electronAPI.notifyMouseLeave(notificationData.id);
    }
  });

  if (!closeButton) {
    console.error("[NotificationRenderer] setupEventListeners: closeButton is null after DOM selection. Cannot add click listener.");
    return;
  }
  closeButton.addEventListener('click', () => {
    console.log(`[NotificationRenderer] Event: closeButton clicked for notification ID: ${notificationData ? notificationData.id : 'unknown'}`);
    closeNotification();
    if (notificationData && notificationData.id && window.electronAPI && window.electronAPI.requestManualClose) {
      window.electronAPI.requestManualClose(notificationData.id);
    } else {
      console.error('[NotificationRenderer] Cannot send manual close request: notificationData, ID, or API missing.');
    }
  });
  console.log('[NotificationRenderer] Event listeners set up.');
}

async function renderNotification(data) {
  if (!data || typeof data.title === 'undefined' || typeof data.content === 'undefined') {
    console.error('[NotificationRenderer] renderNotification: ERROR - Received incomplete or invalid data object. Aborting render.');
    if (contentElement) contentElement.innerHTML = '<p style="color:red;">渲染错误：通知数据不完整。</p>';
    return;
  }
  if (!titleElement || !contentElement) {
    console.error('[NotificationRenderer] renderNotification: ERROR - titleElement or contentElement is null! Cannot render.');
    if (document.body && !contentElement) document.body.innerHTML = '<p style="color:red;">渲染错误：UI元素丢失。</p>';
    else if (contentElement) contentElement.innerHTML = '<p style="color:red;">渲染错误：UI元素丢失。</p>';
    return;
  }

  titleElement.textContent = data.title;

  if (!window.electronAPI || !window.electronAPI.renderMarkdown) {
      console.error("[NotificationRenderer] renderMarkdown API not available on window.electronAPI. Rendering raw content.");
      contentElement.textContent = data.content;
  } else {
      try {
        const htmlContent = await window.electronAPI.renderMarkdown(data.content);
        contentElement.innerHTML = htmlContent;
        const links = contentElement.querySelectorAll('a');
        links.forEach(link => {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        });
      } catch (error) {
        console.error('[NotificationRenderer] renderNotification: ERROR receiving HTML from main process or setting innerHTML:', error);
        contentElement.innerHTML = `<p style="color:red;">渲染内容时出错。</p><pre>${data.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
      }
  }

  if (!container) {
    console.error("[NotificationRenderer] renderNotification: container is null before setTimeout.");
    return;
  }

  const timeoutId = setTimeout(() => {
    if (!container || !data || !data.id) {
        console.error(`[NotificationRenderer] Inside setTimeout (ID: ${timeoutId}): ERROR - Container or data is null/invalid.`);
        return;
    }
    
    const headerElement = container.querySelector('.notification-header');
    let hHeight = 0, cScrollHeight = 0, cOffsetHeight = 0;
    let containerPaddingTop = 0, containerPaddingBottom = 0;
    let containerBorderTop = 0, containerBorderBottom = 0;
    let contentComputedHeight = 'N/A', contentMaxHeight = 'N/A', containerComputedHeight = 'N/A';

    if (headerElement) hHeight = headerElement.offsetHeight;
    if (contentElement) {
        cScrollHeight = contentElement.scrollHeight;
        cOffsetHeight = contentElement.offsetHeight;
        const contentStyle = getComputedStyle(contentElement);
        contentComputedHeight = contentStyle.height;
        contentMaxHeight = contentStyle.maxHeight;
    }
    if (container) {
        const containerStyle = getComputedStyle(container);
        containerPaddingTop = parseFloat(containerStyle.paddingTop) || 0;
        containerPaddingBottom = parseFloat(containerStyle.paddingBottom) || 0;
        containerBorderTop = parseFloat(containerStyle.borderTopWidth) || 0;
        containerBorderBottom = parseFloat(containerStyle.borderBottomWidth) || 0;
        containerComputedHeight = containerStyle.height;
    }

    const calculatedHeightForContainer = hHeight + cScrollHeight + 
                                       containerPaddingTop + containerPaddingBottom + 
                                       containerBorderTop + containerBorderBottom;
    
    const heightToSend = Math.max(calculatedHeightForContainer, 30); 
    
    if (window.electronAPI && window.electronAPI.requestResize) {
        // console.log(`[NotificationRenderer] Sending resize request for ID ${data.id} with calculated height: ${heightToSend}`);
        window.electronAPI.requestResize(data.id, heightToSend);
    } else {
        console.error("[NotificationRenderer] Inside setTimeout: requestResize API not available.");
    }
    
    container.classList.add('active');
  }, 50); 
}

function closeNotification() {
  if (!container) {
      console.error("[NotificationRenderer] closeNotification: container is null.");
      return;
  }
  container.classList.remove('active');
  container.classList.add('hiding');
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('[NotificationRenderer] Event: DOMContentLoaded fired.');
  initialize();
});