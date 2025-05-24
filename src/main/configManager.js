const fs = require('fs');
const path = require('path');
const os = require('os');

let configPath = '';

function getConfigPath() {
  if (configPath) return configPath;
  let appDataPath = '';
  switch (process.platform) {
    case 'win32':
      appDataPath = path.join(process.env.APPDATA, 'NovaNotif');
      break;
    case 'darwin':
      appDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'NovaNotif');
      break;
    default: 
      appDataPath = path.join(os.homedir(), '.config', 'novanotif');
      break;
  }
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }
  configPath = path.join(appDataPath, 'config.json');
  return configPath;
}

const defaultConfig = {
  theme: 'system', 
  server: {
    port: 38080
  },
  udp: {
    enabled: true,
    port: 38081,
    broadcastAddress: '255.255.255.255',
    broadcastPort: 38081,
    sharedKey: ''
  },
  notification: {
    maxVisible: 3,
    defaultTimeout: 5000,
    maxWidth: 0.2,
    maxHeight: 0.33, 
    minHeight: 30,   
    spacing: 10,
    marginTop: 10,   
    marginRight: 10, 
    animation: {
      duration: 300,
      reStackDuration: 150 
    }
  },
  style: {
    customCssPath: ''
  }
};

function loadConfig() {
  const configFilePath = getConfigPath();
  if (!fs.existsSync(configFilePath)) {
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  try {
    const configData = fs.readFileSync(configFilePath, 'utf8');
    const userConfig = JSON.parse(configData);
    return mergeConfigs(defaultConfig, userConfig);
  } catch (error) {
    console.error('加载配置文件时出错:', error);
    return defaultConfig;
  }
}

function saveConfig(currentConfig) {
  const configFilePath = getConfigPath();
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(currentConfig, null, 2), 'utf8');
    console.log('[ConfigManager] Configuration saved to:', configFilePath);
    return true;
  } catch (error) {
    console.error('保存配置文件时出错:', error);
    return false;
  }
}

function mergeConfigs(defaultConf, userConf) {
  const result = { ...defaultConf };
  for (const key in userConf) {
    if (Object.prototype.hasOwnProperty.call(userConf, key)) {
      if (userConf[key] && typeof userConf[key] === 'object' && !Array.isArray(userConf[key]) &&
          defaultConf[key] && typeof defaultConf[key] === 'object' && !Array.isArray(defaultConf[key])) {
        result[key] = mergeConfigs(defaultConf[key], userConf[key]);
      } else if (typeof userConf[key] !== 'undefined') {
        result[key] = userConf[key];
      }
    }
  }
  return result;
}

function getCustomCss() {
  const currentConfig = loadConfig();
  if (!currentConfig.style.customCssPath) {
    return '';
  }
  try {
    return fs.readFileSync(currentConfig.style.customCssPath, 'utf8');
  } catch (error) {
    console.error('读取自定义CSS文件时出错:', error);
    return '';
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  getCustomCss,
  defaultConfig,
  getConfigPath
};