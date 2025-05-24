#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { program } = require('commander');

// 配置文件路径
let configPath = '';

// 根据操作系统确定配置文件路径
function getConfigPath() {
  if (configPath) return configPath;
  
  let appDataPath = '';
  
  // 根据不同操作系统确定应用数据目录
  switch (process.platform) {
    case 'win32':
      appDataPath = path.join(process.env.APPDATA, 'NovaNotif');
      break;
    case 'darwin':
      appDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'NovaNotif');
      break;
    default: // Linux 和其他
      appDataPath = path.join(os.homedir(), '.config', 'novanotif');
      break;
  }
  
  configPath = path.join(appDataPath, 'config.json');
  return configPath;
}

// 加载配置
function loadConfig() {
  const configFilePath = getConfigPath();
  
  // 如果配置文件不存在，返回默认配置
  if (!fs.existsSync(configFilePath)) {
    return {
      server: {
        port: 38080
      },
      udp: {
        enabled: true,
        port: 38081,
        broadcastAddress: '255.255.255.255',
        broadcastPort: 38081
      }
    };
  }
  
  try {
    // 读取并解析配置文件
    const configData = fs.readFileSync(configFilePath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('加载配置文件时出错:', error);
    process.exit(1);
  }
}

// 发送通知
function sendNotification(options) {
  const config = loadConfig();
  const port = config.server.port || 38080;
  
  // 准备通知数据
  const notification = {
    title: options.title,
    content: options.content,
    timeout: options.timeout
  };
  
  // 如果设置了广播标志，添加到通知数据
  if (options.broadcast) {
    notification.broadcast = true;
  }
  
  // 准备请求数据
  const postData = JSON.stringify(notification);
  
  // 准备请求选项
  const requestOptions = {
    hostname: '127.0.0.1',
    port: port,
    path: '/notify',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  
  // 发送请求
  const req = http.request(requestOptions, (res) => {
    // 检查响应状态码
    if (res.statusCode !== 200) {
      console.error(`请求失败，状态码: ${res.statusCode}`);
      process.exit(1);
    }
    
    // 读取响应数据
    let responseData = '';
    res.on('data', (chunk) => {
      responseData += chunk;
    });
    
    res.on('end', () => {
      try {
        const response = JSON.parse(responseData);
        if (response.success) {
          // 成功发送通知
          if (options.verbose) {
            console.log('通知已成功发送');
          }
          process.exit(0);
        } else {
          console.error('发送通知失败:', response.error || '未知错误');
          process.exit(1);
        }
      } catch (error) {
        console.error('解析响应数据时出错:', error);
        process.exit(1);
      }
    });
  });
  
  // 处理请求错误
  req.on('error', (error) => {
    console.error('发送请求时出错:', error.message);
    console.error('确保 NovaNotif 守护进程正在运行');
    process.exit(1);
  });
  
  // 发送请求数据
  req.write(postData);
  req.end();
}

// 配置命令行参数
program
  .name('novanotif')
  .description('NovaNotif 命令行工具 - 发送桌面通知')
  .version('1.0.0');

program
  .requiredOption('-t, --title <title>', '通知标题')
  .requiredOption('-c, --content <content>', '通知内容 (支持 Markdown 和数学公式)')
  .option('-d, --timeout <ms>', '通知显示时间 (毫秒)', parseInt, 5000)
  .option('-b, --broadcast', '通过 UDP 广播通知到网络中的其他设备')
  .option('-v, --verbose', '显示详细输出');

// 解析命令行参数
program.parse(process.argv);

// 获取选项
const options = program.opts();

// 发送通知
sendNotification(options);
