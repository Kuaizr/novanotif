#!/usr/bin/env node

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeTheme, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const url = require('url');
const dgram = require('dgram');
const { program } = require('commander');
const { v4: uuidv4 } = require('uuid');

const configManager = require('./configManager');
const windowController = require('./windowController');
const daemon = require('./daemon');

// --- Global/Early Constants ---
const isDev = process.argv.includes('--dev');
const SENDER_INSTANCE_ID = uuidv4();

// --- Function Definitions ---
function sendNotificationHttpRequest(optionsForCli) {
    return new Promise((resolve, reject) => {
        const currentConfig = configManager.loadConfig();
        const port = currentConfig.server?.port || 38080;

        const notificationPayload = {
            title: optionsForCli.title,
            content: optionsForCli.content,
            timeout: optionsForCli.timeout,
            broadcast: optionsForCli.broadcast || false,
        };
        const postData = JSON.stringify(notificationPayload);

        const requestOptions = {
            hostname: '127.0.0.1',
            port: port,
            path: '/notify',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        const req = http.request(requestOptions, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(responseData);
                        if (response.success) {
                            resolve(response);
                        } else {
                            reject(new Error(`发送通知失败: ${response.error || '未知错误'}`));
                        }
                    } catch (error) {
                        reject(new Error(`解析响应数据时出错: ${error.message}. 响应: ${responseData}`));
                    }
                } else {
                     reject(new Error(`请求失败，状态码: ${res.statusCode}. 响应: ${responseData}`));
                }
            });
        });
        req.on('error', (error) => {
            if (error.code === 'ECONNREFUSED') {
                reject(new Error('发送请求时出错: 连接被拒绝。请确保 NovaNotif 守护进程正在运行。'));
            } else {
                reject(new Error(`发送请求时出错: ${error.message}`));
            }
        });
        req.write(postData);
        req.end();
    });
}

// --- Commander Parameter Definition ---
program
    .name('novanotif')
    .description('NovaNotif - 跨平台桌面通知系统，通过命令行或HTTP/UDP接口发送通知。')
    .version(require('../../package.json').version, '-V, --version', '输出当前版本号') //
    .option('-t, --title <value>', '通知标题')
    .option('-c, --content <value>', '通知内容 (支持 Markdown 和 KaTeX 数学公式)')
    .option('-d, --timeout <value>', '通知显示时间 (毫秒)', (value) => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed) || parsed < 0) {
            console.error("错误: --timeout 的值必须是一个有效的正整数。");
            throw new program.InvalidArgumentError('超时值必须是有效的正整数。');
        }
        return parsed;
    })
    .option('-b, --broadcast', '通过 UDP 广播通知到网络中的其他设备')
    .option('-v, --verbose', '显示详细输出')
    .helpOption('-h, --help', '显示帮助信息')
    .addHelpText('after', `

使用示例:
  novanotif -t "欢迎" -c "这是你的第一条 NovaNotif 通知！"
  novanotif -t "提醒" -c "会议将在 **5分钟** 后开始。" -d 10000
  novanotif -t "网络消息" -c "重要更新已部署" -b

如果未指定任何参数，并且没有正在运行的 NovaNotif 实例，则会启动后台守护进程。
如果实例已在运行，则不带 -t 和 -c 参数的命令将不会执行任何操作 (除非带 -v)。`)
    .exitOverride((err) => {
        if (err.code === 'commander.helpDisplayed' || err.code === 'commander.versionDisplayed') {
            if (app && typeof app.quit === 'function' && app.isReady()) app.quit();
            else process.exit(0);
        } else {
            if (app && typeof app.quit === 'function' && app.isReady()) app.quit();
            else process.exit(1);
        }
        throw err;
    });


// --- Prepare and Parse Command Line Arguments ---
const rawArgs = process.defaultApp
    ? process.argv.slice(2)
    : process.argv.slice(1);

const cleanUserArgs = rawArgs.filter(arg => arg !== '--dev');

let cmdLineOptions;
try {
    program.parse(cleanUserArgs, { from: 'user' });
    cmdLineOptions = program.opts();
} catch (err) {
    if (app && typeof app.quit === 'function' && !app.isQuitting()) {
        app.quit();
    } else if (!app || (app && !app.isQuitting())) {
        process.exit(1);
    }
    throw err;
}

// --- Command Line Logic Evaluation ---
const isNotificationAttempt = cmdLineOptions.title !== undefined || cmdLineOptions.content !== undefined;
const isNotificationCommand = cmdLineOptions.title !== undefined && cmdLineOptions.content !== undefined;
const isInvalidNotificationAttempt = isNotificationAttempt && !isNotificationCommand;

if (isInvalidNotificationAttempt) {
    console.error('错误: 发送通知需要同时提供 --title 和 --content 参数。');
    if (app && typeof app.quit === 'function' && !app.isQuitting()) {
         app.quit();
    } else if (!app || (app && !app.isQuitting())) {
        process.exit(1);
    }
    throw new Error("Invalid command: Missing title or content for notification.");
}

// --- Electron Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock(cmdLineOptions);

if (!gotTheLock) {
    if (isNotificationCommand) {
        if (cmdLineOptions.verbose) console.log("NovaNotif 已在运行。通知数据已通过 'second-instance' 事件传递。此实例将退出。");
    } else {
        if (cmdLineOptions.verbose) console.log("NovaNotif 守护进程已在运行。此实例将退出。");
    }
    app.quit();
} else {
    // This is the first instance
    app.on('second-instance', (event, commandLineArgvOfSecondInstance, workingDirectory, additionalDataFromSecondInstance) => {
        const secondaryOptions = additionalDataFromSecondInstance;

        if (cmdLineOptions.verbose) {
            console.log("[主实例] 收到 second-instance 事件。");
            console.log("[主实例] 来自第二实例的已解析选项 (通过 additionalData):", JSON.stringify(secondaryOptions));
        }

        if (secondaryOptions && secondaryOptions.title && secondaryOptions.content) {
            if (cmdLineOptions.verbose || secondaryOptions.verbose) {
                console.log('[主实例] 收到来自第二实例的有效通知请求:', secondaryOptions);
            }
            const notificationData = {
                title: secondaryOptions.title,
                content: secondaryOptions.content,
                timeout: secondaryOptions.timeout,
                broadcast: secondaryOptions.broadcast || false,
            };
            
            windowController.createNotification(notificationData); //
            if (notificationData.broadcast && mainConfig.udp && mainConfig.udp.enabled && daemon) {
                const broadcastPayload = { ...notificationData, senderInstanceId: SENDER_INSTANCE_ID };
                daemon.broadcastNotification(broadcastPayload); //
            }
        } else if (secondaryOptions && (secondaryOptions.title || secondaryOptions.content)) {
            console.warn('[主实例] 第二实例尝试发送通知但缺少 --title 或 --content。该实例应自行退出。');
        } else {
            if (cmdLineOptions.verbose) console.log("[主实例] 第二实例未发送通知命令。");
        }

        const allWindows = BrowserWindow.getAllWindows();
        if (allWindows.length > 0) {
            const win = allWindows[0];
            if (win) {
                if (win.isMinimized()) win.restore();
                win.focus();
            }
        }
    });

    // --- Electron Main Application Logic ---
    let tray = null;
    let server = null;
    let udpServer = null;
    let mainConfig = null;
    let markdownItInstance;

    try {
        const MarkdownIt = require('markdown-it');
        const markdownItKatex = require('markdown-it-katex');
        markdownItInstance = new MarkdownIt({
            html: false, linkify: true, typographer: true, breaks: true
        }).disable(['image', 'html_block', 'html_inline']);
        markdownItInstance.use(markdownItKatex, { "throwOnError": false, "errorColor": " #cc0000" });
        if (cmdLineOptions.verbose) console.log('[主进程] Markdown-it (KaTeX支持) 初始化成功。');
    } catch (error) {
        console.error('[主进程] 初始化 Markdown-it (KaTeX支持) 失败:', error);
        try {
            const MarkdownIt = require('markdown-it');
            markdownItInstance = new MarkdownIt({
                html: false, linkify: true, typographer: true, breaks: true
            }).disable(['image', 'html_block', 'html_inline']);
            console.warn('[主进程] Markdown-it (无KaTeX支持) 因先前错误而已初始化。');
        } catch (mdError) {
            console.error('[主进程] 初始化 Markdown-it 基础版失败:', mdError);
            markdownItInstance = null;
        }
    }

    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return '';
        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function buildContextMenuTemplate(currentMainConfig, currentCmdLineOptions) {
      return [
        { label: 'NovaNotif 正在运行', enabled: false },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            { label: '浅色', type: 'radio', checked: currentMainConfig?.theme === 'light', click: () => ipcMain.emit('set-theme', {}, 'light') },
            { label: '深色', type: 'radio', checked: currentMainConfig?.theme === 'dark', click: () => ipcMain.emit('set-theme', {}, 'dark') },
            { label: '跟随系统', type: 'radio', checked: currentMainConfig?.theme === 'system', click: () => ipcMain.emit('set-theme', {}, 'system') }
          ]
        },
        { type: 'separator' },
        {
          label: '复制配置文件路径',
          click: () => {
            const cfgPath = configManager.getConfigPath(); // This should now work
            clipboard.writeText(cfgPath);
            if (currentMainConfig?.verbose || currentCmdLineOptions?.verbose) {
              console.log(`[主进程] 配置文件路径已复制到剪贴板: ${cfgPath}`);
            }
            windowController.createNotification({ //
                title: '通知',
                content: `配置文件路径：\n${cfgPath}\n已复制到剪切板`,
                timeout: 3000
            });
          }
        },
        { type: 'separator' },
        { label: '退出', click: () => { app.quit(); } }
      ];
    }

    app.whenReady().then(async () => {
        mainConfig = configManager.loadConfig();
        if (cmdLineOptions.verbose) {
            mainConfig.verbose = true;
        }
        mainConfig.currentInstanceId = SENDER_INSTANCE_ID;


        windowController.init(mainConfig, nativeTheme); //
        daemon.init(mainConfig, windowController); //


        if (mainConfig.theme === 'system') {
            nativeTheme.themeSource = 'system';
        } else if (mainConfig.theme === 'dark') {
            nativeTheme.themeSource = 'dark';
        } else {
            nativeTheme.themeSource = 'light';
        }

        createTray();
        startHttpServer();
        if (mainConfig.udp && mainConfig.udp.enabled) {
            startUdpServer(SENDER_INSTANCE_ID);
        }

        ipcMain.handle('render-markdown-to-html', async (event, markdownContent) => {
            if (markdownItInstance && typeof markdownContent === 'string') {
                try { return markdownItInstance.render(markdownContent); }
                catch (renderError) {
                    console.error('[主进程] Markdown 渲染错误:', renderError);
                    return `<p style="color: red;">内容渲染错误。</p><pre>${escapeHtml(markdownContent)}</pre>`;
                }
            } else if (typeof markdownContent === 'string') {
                console.warn('[主进程] Markdown 引擎不可用，返回原始已转义内容。');
                return `<pre>${escapeHtml(markdownContent)}</pre>`;
            }
            console.error('[主进程] render-markdown-to-html: 参数无效或Markdown引擎未就绪。');
            return '<p style="color: red;">参数无效或Markdown引擎未就绪。</p>';
        });

        if (isNotificationCommand) {
            if (cmdLineOptions.verbose) console.log('[主实例] 处理来自首次启动的命令行通知:', cmdLineOptions);
            const initialNotificationData = {
                title: cmdLineOptions.title,
                content: cmdLineOptions.content,
                timeout: cmdLineOptions.timeout,
                broadcast: cmdLineOptions.broadcast || false,
            };

            windowController.createNotification(initialNotificationData); //
            if (initialNotificationData.broadcast && mainConfig.udp && mainConfig.udp.enabled) {
                const broadcastPayload = { ...initialNotificationData, senderInstanceId: SENDER_INSTANCE_ID };
                daemon.broadcastNotification(broadcastPayload); //
            }
        } else if (cmdLineOptions.verbose && !isNotificationAttempt) {
            console.log('[主实例] NovaNotif 守护进程已启动。没有初始通知命令。');
        }

        if (isDev && !isNotificationAttempt) {
            console.log('开发模式，1秒后显示测试通知...');
            setTimeout(() => {
                windowController.createNotification({ //
                    title: '开发模式测试',
                    content: `这是一个测试通知，目的是测试高度自适应。\n当前时间: ${new Date().toLocaleTimeString()}\n$$E=mc^2$$`,
                    timeout: 20000
                });
            }, 1000);
        }
    });

    function createTray() {
        const iconName = process.platform === 'win32' ? 'app.png' : 'app.png';
        let effectiveIconPath = '';

        if (app.isPackaged) {
            effectiveIconPath = path.join(process.resourcesPath, 'assets', 'icons', iconName);
            if (!require('fs').existsSync(effectiveIconPath)) {
                effectiveIconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icons', iconName);
            }
            if (process.platform === 'darwin' && !require('fs').existsSync(effectiveIconPath) ) {
                effectiveIconPath = path.join(app.getAppPath(), '..', 'assets', 'icons', iconName);
                if (!require('fs').existsSync(effectiveIconPath)) {
                    effectiveIconPath = path.join(app.getAppPath(), 'assets', 'icons', iconName);
                }
            }
            if (!require('fs').existsSync(effectiveIconPath) && process.platform !== 'darwin') {
                effectiveIconPath = path.join(path.dirname(app.getPath('exe')), 'assets', 'icons', iconName);
            }
        } else {
            effectiveIconPath = path.join(__dirname, '..', '..', 'assets', 'icons', iconName);
        }

        if (mainConfig?.verbose || cmdLineOptions.verbose) console.log(`[主进程] 最终尝试加载托盘图标路径: ${effectiveIconPath}`);
        if (!require('fs').existsSync(effectiveIconPath)) {
            console.error(`[主进程] 错误：托盘图标文件未找到于路径: ${effectiveIconPath}`);
        }

        try {
            tray = new Tray(effectiveIconPath);
        } catch (trayError) {
            console.error(`[主进程] 创建托盘图标失败: ${trayError.message}. 使用路径: ${effectiveIconPath}`);
            return;
        }

        const contextMenu = Menu.buildFromTemplate(buildContextMenuTemplate(mainConfig, cmdLineOptions));

        tray.setToolTip('NovaNotif');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            if (mainConfig?.verbose || cmdLineOptions.verbose) console.log("托盘图标被点击。");
        });
    }

    function startHttpServer() {
        const port = mainConfig?.server?.port || 38080;
        server = http.createServer((req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
                return;
            }
            const parsedUrl = url.parse(req.url);
            if (parsedUrl.pathname !== '/notify') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Not Found' }));
                return;
            }
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
                if (body.length > 1e6) {
                    req.socket.destroy();
                    console.error('[HTTP服务器] 收到过大的 payload，连接已断开。');
                }
            });
            req.on('end', () => {
                try {
                    const notification = JSON.parse(body);
                    if (!notification.title || !notification.content) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: '请求错误: 缺少 title 或 content 字段' }));
                        return;
                    }
                    if (mainConfig?.verbose || cmdLineOptions.verbose) console.log("[HTTP服务器] 收到通知请求:", notification);
                    
                    windowController.createNotification(notification); //

                    if (notification.broadcast && mainConfig.udp && mainConfig.udp.enabled) {
                        const broadcastPayload = { ...notification, senderInstanceId: SENDER_INSTANCE_ID };
                        daemon.broadcastNotification(broadcastPayload); //
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: '通知已接收' }));
                } catch (error) {
                    console.error('[HTTP服务器] 处理通知请求时出错:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '请求错误: 无效的 JSON' }));
                }
            });
        });
        server.listen(port, '127.0.0.1', () => {
            console.log(`HTTP服务器运行在 http://127.0.0.1:${port}`);
        });
        server.on('error', (error) => {
            console.error('HTTP服务器错误:', error);
            if (error.code === 'EADDRINUSE') {
                console.error(`端口 ${port} 已被占用。NovaNotif 可能已在运行或端口被其他程序占用。`);
                app.quit();
            }
        });
    }

    function startUdpServer(currentInstanceId) {
        const port = mainConfig?.udp?.port || 38081;
        udpServer = dgram.createSocket('udp4');
        udpServer.on('error', (err) => {
            console.error(`UDP服务器错误:\n${err.stack}`);
            try { udpServer.close(); } catch (e) { /* ignore */ }
        });
        udpServer.on('message', (msg, rinfo) => {
            if (mainConfig?.verbose || cmdLineOptions.verbose) {
                console.log(`[UDP服务器] 收到来自 ${rinfo.address}:${rinfo.port} 的消息`);
            }
            try {
                const receivedNotification = JSON.parse(msg.toString());

                if (receivedNotification.senderInstanceId && receivedNotification.senderInstanceId === currentInstanceId) {
                    if (mainConfig?.verbose || cmdLineOptions.verbose) {
                        console.log(`[UDP服务器] 忽略来自本机实例 (${currentInstanceId}) 的环回广播消息。`);
                    }
                    return;
                }

                if (!receivedNotification.title || !receivedNotification.content) {
                    console.error('[UDP服务器] 收到无效的UDP通知消息 (缺少 title 或 content)');
                    return;
                }
                if (mainConfig.udp.sharedKey && receivedNotification.key !== mainConfig.udp.sharedKey) {
                    console.warn(`[UDP服务器] 来自 ${rinfo.address} 的UDP消息密钥验证失败。`);
                    return;
                }
                windowController.createNotification(receivedNotification); //
            } catch (error) {
                console.error('[UDP服务器] 处理UDP消息时出错:', error);
            }
        });
        udpServer.on('listening', () => {
            const address = udpServer.address();
            console.log(`UDP服务器监听在 ${address.address}:${address.port}`);
            try { udpServer.setBroadcast(true); }
            catch (e) { console.error('UDP服务器设置广播失败:', e); }
        });
        try {
            udpServer.bind(port);
        } catch (bindErr) {
            console.error(`UDP服务器绑定端口 ${port} 失败:`, bindErr);
            if (bindErr.code === 'EADDRINUSE') {
                console.error(`UDP端口 ${port} 已被占用。`);
            }
        }
    }

    app.on('window-all-closed', () => {
        if (mainConfig?.verbose || cmdLineOptions.verbose) console.log('[主进程] 所有窗口已关闭 (NovaNotif 在托盘运行)。');
    });

    app.on('before-quit', () => {
        console.log('[主进程] 应用即将退出，清理资源...');
        if (server) {
            server.close(() => { console.log('HTTP 服务器已关闭。'); });
        }
        if (udpServer) {
            try { udpServer.close(() => { console.log('UDP 服务器已关闭。'); }); } catch (e) { /* ignore */ }
        }
        if (tray) {
            tray.destroy();
        }
    });

    ipcMain.on('notification-mouse-enter', (event, id) => { windowController.pauseNotificationTimeout(id); }); //
    ipcMain.on('notification-mouse-leave', (event, id) => { windowController.resumeNotificationTimeout(id); }); //
    ipcMain.on('resize-notification', (event, data) => {
        if (data && typeof data.id !== 'undefined' && typeof data.height === 'number') {
            windowController.resizeNotification(data.id, data.height); //
        } else {
            console.error('[主进程] IPC: resize-notification 收到无效数据:', data);
        }
    });
    ipcMain.on('user-close-notification', (event, notificationId) => {
        if (notificationId) {
            if (mainConfig?.verbose || cmdLineOptions.verbose) console.log(`[主进程] IPC: user-close-notification ID: ${notificationId}`);
            windowController.closeNotification(notificationId); //
        } else {
            console.error('[主进程] IPC: user-close-notification 收到无 ID 请求。');
        }
    });

    ipcMain.on('set-theme', (event, requestedTheme) => {
        if (['light', 'dark', 'system'].includes(requestedTheme)) {
            if (mainConfig?.verbose || cmdLineOptions.verbose) console.log(`[主进程] 设置主题为: ${requestedTheme}`);
            if (mainConfig) mainConfig.theme = requestedTheme;
            configManager.saveConfig(mainConfig); //

            if (requestedTheme === 'system') nativeTheme.themeSource = 'system';
            else if (requestedTheme === 'dark') nativeTheme.themeSource = 'dark';
            else nativeTheme.themeSource = 'light';

            if (tray && mainConfig) {
                const newContextMenu = Menu.buildFromTemplate(buildContextMenuTemplate(mainConfig, cmdLineOptions));
                tray.setContextMenu(newContextMenu);
            }
        }
    });

    nativeTheme.on('updated', () => {
        if (mainConfig?.verbose || cmdLineOptions.verbose) console.log('[主进程] nativeTheme 已更新。');
        const newActualTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        windowController.broadcastThemeChange(newActualTheme); //
    });

} // End of 'gotTheLock' (first instance) block