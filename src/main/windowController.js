const { BrowserWindow, screen, ipcMain } = require('electron');
const path =require('path');

let activeNotifications = [];
let notificationQueue = [];
let config = null;
let nativeThemeInstance = null; // To store the nativeTheme instance

function init(appConfig, electronNativeTheme) { // Accept nativeTheme
  config = appConfig;
  nativeThemeInstance = electronNativeTheme; // Store it
  console.log('[WindowController] Initialized.');
}

function createNotificationWindow(notification) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workAreaSize;
  const windowWidth = Math.floor(workArea.width * (config?.notification?.maxWidth || 0.2));

  const notificationWindow = new BrowserWindow({
    width: windowWidth,
    height: 100, // Initial height, will be adjusted
    x: workArea.width,
    y: workArea.y + (config?.notification?.marginTop || 10),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../renderer/preload.js')
    }
  });

  // Determine the actual theme to apply
  let actualTheme = config.theme;
  if (actualTheme === 'system') {
    actualTheme = nativeThemeInstance.shouldUseDarkColors ? 'dark' : 'light';
  }
  const dataToSend = { ...notification, actualTheme }; // Add actualTheme to the data

  notificationWindow.loadFile(path.join(__dirname, '../renderer/notification.html'))
    .then(() => {
      notificationWindow.webContents.send('notification-data', dataToSend); // Send data with theme
    })
    .catch(err => {
      console.error(`[WindowController] FAILED to load notification.html for ID: ${notification.id}`, err);
    });

  notificationWindow.on('close', (event) => {
    event.preventDefault();
  });

  return notificationWindow;
}

function animateWindowIntrusion(win, targetX, targetY, duration) {
  if (!win || win.isDestroyed()) {
    return;
  }

  if (typeof targetY !== 'number' || isNaN(targetY) || !isFinite(targetY) ||
      typeof targetX !== 'number' || isNaN(targetX) || !isFinite(targetX)) {
    console.error(`[WindowController] ERROR: Invalid targetX (${targetX}) or targetY (${targetY}) for animation. Window ID (if available): ${win.id || 'N/A'}.`);
    if (!win.isDestroyed()) {
        try { win.setPosition(Math.round(isFinite(targetX) ? targetX : win.getBounds().x) , Math.round(isFinite(targetY) ? targetY : win.getBounds().y)); } catch(e) {}
    }
    return;
  }

  const startBounds = win.getBounds();
  const startX = startBounds.x;
  const effectiveDuration = Math.max(duration, 50);
  const startTime = Date.now();

  function frame() {
    if (!win || win.isDestroyed()) return;

    const now = Date.now();
    const elapsed = now - startTime;
    let rawProgress = Math.min(elapsed / effectiveDuration, 1);
    let easedProgress = 1 - Math.pow(1 - rawProgress, 3);

    if (isNaN(easedProgress) || !isFinite(easedProgress)) {
      console.error(`[WindowController] ERROR: Invalid progress in animation frame. Setting to final state.`);
      if (!win.isDestroyed()) win.setPosition(targetX, Math.round(targetY));
      return;
    }

    const currentX = startX + (targetX - startX) * easedProgress;
    const finalAnimatedX = Math.round(currentX);

    if (typeof finalAnimatedX !== 'number' || isNaN(finalAnimatedX) || !isFinite(finalAnimatedX)) {
      console.error(`[WindowController] ERROR: Invalid calculated X for setPosition! Setting to final state.`);
      if (!win.isDestroyed()) win.setPosition(targetX, Math.round(targetY));
      return;
    }

    try {
      win.setPosition(finalAnimatedX, Math.round(targetY));
    } catch (e) {
      console.error(`[WindowController] ERROR during win.setPosition(x:${finalAnimatedX}, y:${Math.round(targetY)}):`, e);
      return;
    }

    if (rawProgress < 1) {
      setImmediate(frame);
    } else {
      if (!win.isDestroyed()) {
        win.setPosition(targetX, Math.round(targetY));
      }
    }
  }
  setImmediate(frame);
}

function resizeNotification(id, heightFromRenderer) {
  const notification = activeNotifications.find(n => n.id === id);

  if (!notification || !notification.window || notification.window.isDestroyed()) {
    console.error(`[WindowController] resizeNotification: Invalid notification or window for ID ${id}.`);
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workAreaSize;
  const windowWidth = notification.window.getSize()[0];

  const maxScreenHeightRatio = config?.notification?.maxHeight || 0.33;
  const configuredMinHeight = config?.notification?.minHeight || 30;
  const animationDuration = config?.notification?.animation?.duration || 300;
  const marginRight = config?.notification?.marginRight || 10;


  const maxHeight = Math.floor(workArea.height * maxScreenHeightRatio);
  const newHeight = Math.min(Math.max(heightFromRenderer, configuredMinHeight), maxHeight);

  const heightActuallyChanged = notification.height !== newHeight;
  notification.height = newHeight;
  notification.window.setSize(windowWidth, newHeight);

  const newYPositions = calculateYPositions();
  const currentNotificationNewY = newYPositions[id];

  if (typeof currentNotificationNewY !== 'number' || isNaN(currentNotificationNewY) || !isFinite(currentNotificationNewY)) {
      console.error(`[WindowController] resizeNotification: Invalid new Y position (${currentNotificationNewY}) calculated for notification ${id}.`);
      return;
  }
  notification.y = currentNotificationNewY;

  const targetX = workArea.width - windowWidth - marginRight;

  if (!notification.window.isVisible()) {
    notification.window.setBounds({
      x: workArea.width,
      y: currentNotificationNewY,
      width: windowWidth,
      height: newHeight
    });
    notification.window.show();
    animateWindowIntrusion(notification.window, targetX, currentNotificationNewY, animationDuration);
  } else if (heightActuallyChanged) {
    animateWindowIntrusion(notification.window, targetX, currentNotificationNewY, config?.notification?.animation?.reStackDuration || 150);
    updateAllNotificationsPositionsAnimated(newYPositions, id);
  } else {
    const currentBounds = notification.window.getBounds();
    if(currentBounds.x !== targetX || currentBounds.y !== currentNotificationNewY) {
        animateWindowIntrusion(notification.window, targetX, currentNotificationNewY, config?.notification?.animation?.reStackDuration || 150);
    }
  }
}

function calculateYPositions() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const workAreaY = primaryDisplay?.workArea?.y || 0;
    const marginTop = config?.notification?.marginTop || 10;
    const spacing = config?.notification?.spacing || 10;

    let currentY = marginTop + workAreaY;
    const positions = {};

    for (const n of activeNotifications) {
        if (!n.window || n.window.isDestroyed()) continue;
        
        const notificationHeight = (typeof n.height === 'number' && !isNaN(n.height) && isFinite(n.height) && n.height > 0)
                                   ? n.height
                                   : 100;

        if (isNaN(currentY) || !isFinite(currentY)) {
            console.error(`[WindowController] CRITICAL: currentY became invalid (${currentY}) while calculating positions. Resetting.`);
            currentY = marginTop + workAreaY;
        }
        positions[n.id] = Math.round(currentY);
        n.y = Math.round(currentY);
        currentY += notificationHeight + spacing;
    }
    return positions;
}

function updateAllNotificationsPositionsAnimated(newYPositions, excludedId = null) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workAreaSize;
    const marginRight = config?.notification?.marginRight || 10;
    const reStackDuration = config?.notification?.animation?.reStackDuration || 150;


    for (const n of activeNotifications) {
        if (!n.window || n.window.isDestroyed() || n.id === excludedId) continue;

        const windowWidth = n.window.getSize()[0];
        const targetX = workArea.width - windowWidth - marginRight;
        const targetY = newYPositions[n.id];

        if (typeof targetY !== 'number' || isNaN(targetY) || !isFinite(targetY)) {
            console.error(`[WindowController] updateAllNotificationsPositionsAnimated: Invalid targetY (${targetY}) for notification ${n.id}. Skipping.`);
            continue;
        }
        
        const currentBounds = n.window.getBounds();
        if (currentBounds.x !== targetX || currentBounds.y !== targetY) {
            if (n.window.isVisible()) {
                animateWindowIntrusion(n.window, targetX, targetY, reStackDuration);
            } else {
                n.window.setPosition(targetX, targetY);
            }
        }
    }
}

function createNotification(notificationData) {
  if (!config) { console.error("[WindowController] Config not initialized!"); return; }
  if (!nativeThemeInstance) { console.error("[WindowController] NativeTheme not initialized!"); return; }


  const newNotification = { ...notificationData };
  newNotification.timeout = newNotification.timeout || config?.notification?.defaultTimeout || 5000;
  newNotification.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);

  if (activeNotifications.length >= (config?.notification?.maxVisible || 3)) {
    notificationQueue.push(newNotification);
    return;
  }

  const notificationWindow = createNotificationWindow(newNotification);
  if (!notificationWindow) return;

  const newEntry = {
    id: newNotification.id,
    window: notificationWindow,
    timeout: newNotification.timeout,
    timeoutId: null,
    isPaused: false,
    height: 100,
    y: 0
  };
  activeNotifications.push(newEntry);
  
  startNotificationTimeout(newEntry.id);
  return newEntry.id;
}

function closeNotification(id) {
  const index = activeNotifications.findIndex(n => n.id === id);
  if (index === -1) return;

  const notification = activeNotifications[index];

  if (notification.window && !notification.window.isDestroyed()) {
    if (notification.window.webContents) {
      notification.window.webContents.send('notification-close');
    }
    const currentBounds = notification.window.getBounds();
    const targetX_offScreen = screen.getPrimaryDisplay().workAreaSize.width;
    animateWindowIntrusion(notification.window, targetX_offScreen, currentBounds.y, (config?.notification?.animation?.duration || 300) / 2);
  }

  activeNotifications.splice(index, 1);

  setTimeout(() => {
    if (notification.window && !notification.window.isDestroyed()) {
      notification.window.destroy();
    }
    
    const newYPositions = calculateYPositions();
    updateAllNotificationsPositionsAnimated(newYPositions, null);

    if (notificationQueue.length > 0) {
      const nextNotification = notificationQueue.shift();
      createNotification(nextNotification);
    }
  }, (config?.notification?.animation?.duration || 300));
}

function startNotificationTimeout(id) {
  const notification = activeNotifications.find(n => n.id === id);
  if (!notification || !notification.timeout) return;
  if (notification.timeoutId) clearTimeout(notification.timeoutId);
  notification.timeoutId = setTimeout(() => {
    closeNotification(id);
  }, notification.timeout);
}

function pauseNotificationTimeout(id) {
  const notification = activeNotifications.find(n => n.id === id);
  if (!notification || notification.isPaused || !notification.timeoutId) return;
  clearTimeout(notification.timeoutId);
  notification.timeoutId = null;
  notification.isPaused = true;
}

function resumeNotificationTimeout(id) {
  const notification = activeNotifications.find(n => n.id === id);
  if (!notification || !notification.isPaused) return;
  notification.isPaused = false;
  startNotificationTimeout(id);
}

// New function to broadcast theme changes to all active notification windows
function broadcastThemeChange(actualTheme) { // actualTheme is 'light' or 'dark'
  console.log(`[WindowController] Broadcasting theme change to all windows: ${actualTheme}`);
  activeNotifications.forEach(n => {
    if (n.window && !n.window.isDestroyed() && n.window.webContents) {
      n.window.webContents.send('theme-changed', actualTheme);
    }
  });
}

module.exports = {
  init,
  createNotification,
  pauseNotificationTimeout,
  resumeNotificationTimeout,
  closeNotification,
  resizeNotification,
  broadcastThemeChange // Export the new function
};