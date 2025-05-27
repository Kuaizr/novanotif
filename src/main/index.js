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
const IS_DAEMONIZED_ENV_VAR = 'NOVANOTIF_IS_DAEMONIZED'; // 更具体的环境变量名

// --- [DIAGNOSTIC LOG] ---
console.log(`[DIAGNOSTIC] Initial process.argv: ${JSON.stringify(process.argv)}`);
console.log(`[DIAGNOSTIC] isDev: ${isDev}`);
console.log(`[DIAGNOSTIC] SENDER_INSTANCE_ID: ${SENDER_INSTANCE_ID}`);
console.log(`[DIAGNOSTIC] ${IS_DAEMONIZED_ENV_VAR}: ${process.env[IS_DAEMONIZED_ENV_VAR]}`);
// --- [END DIAGNOSTIC LOG] ---

// --- Function Definitions ---
function sendNotificationHttpRequest(optionsForCli) {
    // --- [DIAGNOSTIC LOG] ---
    console.log(`[DIAGNOSTIC] [sendNotificationHttpRequest] Called with options: ${JSON.stringify(optionsForCli)}`);
    // --- [END DIAGNOSTIC LOG] ---
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
                // --- [DIAGNOSTIC LOG] ---
                console.log(`[DIAGNOSTIC] [sendNotificationHttpRequest] Response status: ${res.statusCode}, data: ${responseData}`);
                // --- [END DIAGNOSTIC LOG] ---
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
            // --- [DIAGNOSTIC LOG] ---
            console.error(`[DIAGNOSTIC] [sendNotificationHttpRequest] Request error: ${error.message}`);
            // --- [END DIAGNOSTIC LOG] ---
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
    .version(require('../../package.json').version, '-V, --version', '输出当前版本号')
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
        console.log(`[DIAGNOSTIC] Commander exitOverride: Code: ${err.code}, Message: ${err.message}`);
        if (err.code === 'commander.helpDisplayed' || err.code === 'commander.versionDisplayed') {
            if (app && typeof app.quit === 'function' && app.isReady()) app.quit();
            else process.exit(0);
        } else {
             // 在这里我们还不知道是否是主实例，谨慎处理退出
            if (app && typeof app.quit === 'function' && app.isReady()) {
                 // 如果应用已经 ready，可能是第二个实例的 commander 出错
                 // 或者主实例在解析自己的参数时出错（例如，在 daemonize 之前）
                // 暂时保留之前的逻辑，但 daemonize 可能会影响这个
                if (!app.isDefaultProtocolClient()) { // 尝试避免在主协议客户端处理中过早退出
                   // app.quit(); // 这可能仍然过于激进
                }
            } else {
                process.exit(1);
            }
        }
    });

function mainAppLogic() {
    // --- Prepare and Parse Command Line Arguments ---
    const rawArgs = process.defaultApp
        ? process.argv.slice(2)
        : process.argv.slice(1);
    console.log(`[DIAGNOSTIC] rawArgs for Commander: ${JSON.stringify(rawArgs)}`);
    const cleanUserArgs = rawArgs.filter(arg => arg !== '--dev');
    console.log(`[DIAGNOSTIC] cleanUserArgs for Commander: ${JSON.stringify(cleanUserArgs)}`);

    let cmdLineOptions;
    try {
        program.parse(cleanUserArgs, { from: 'user' });
        cmdLineOptions = program.opts();
        console.log(`[DIAGNOSTIC] Commander parsed cmdLineOptions: ${JSON.stringify(cmdLineOptions)}`);
    } catch (err) {
        console.error(`[DIAGNOSTIC] Commander parsing error: ${err.message}`);
        if (app && typeof app.quit === 'function' && !app.isQuitting()) {
            app.quit();
        } else {
            process.exit(1);
        }
        return; // 确保在解析错误时不再继续
    }

    const isNotificationAttempt = cmdLineOptions.title !== undefined || cmdLineOptions.content !== undefined;
    const isNotificationCommand = cmdLineOptions.title !== undefined && cmdLineOptions.content !== undefined;
    const isInvalidNotificationAttempt = isNotificationAttempt && !isNotificationCommand;

    console.log(`[DIAGNOSTIC] isNotificationAttempt: ${isNotificationAttempt}`);
    console.log(`[DIAGNOSTIC] isNotificationCommand: ${isNotificationCommand}`);
    console.log(`[DIAGNOSTIC] isInvalidNotificationAttempt: ${isInvalidNotificationAttempt}`);

    if (isInvalidNotificationAttempt) {
        console.error('错误: 发送通知需要同时提供 --title 和 --content 参数。');
        if (cmdLineOptions.verbose) {
            console.log('[DIAGNOSTIC] Invalid notification attempt, missing title or content.');
        }
        process.exit(1); // 直接退出
        return;
    }

    const gotTheLock = app.requestSingleInstanceLock();
    console.log(`[DIAGNOSTIC] gotTheLock: ${gotTheLock}`);

    if (!gotTheLock) {
        console.log(`[DIAGNOSTIC] This is a second instance. Parsed cmdLineOptions: ${JSON.stringify(cmdLineOptions)}`);
        console.log(`[DIAGNOSTIC] Second instance's own raw process.argv: ${JSON.stringify(process.argv)}`);

        if (isNotificationCommand) {
            if (cmdLineOptions.verbose) {
                console.log("NovaNotif 已在运行。此实例将通过 HTTP 发送通知数据并退出。");
            }
            sendNotificationHttpRequest(cmdLineOptions)
                .then(response => {
                    if (cmdLineOptions.verbose) {
                        console.log(`[DIAGNOSTIC] [Second Instance] HTTP Notification sent successfully: ${JSON.stringify(response)}`);
                    }
                })
                .catch(error => {
                    console.error(`[DIAGNOSTIC] [Second Instance] Error sending HTTP notification: ${error.message}`);
                })
                .finally(() => {
                    console.log(`[DIAGNOSTIC] [Second Instance] Quitting after attempting HTTP send.`);
                    app.quit();
                });
        } else {
            if (cmdLineOptions.verbose) {
                console.log("NovaNotif 守护进程已在运行。此实例将退出。");
            }
            console.log(`[DIAGNOSTIC] [Second Instance] Not a notification command, quitting.`);
            app.quit();
        }
        return; // 第二个实例的逻辑到此结束
    }

    // --- 主实例逻辑从这里开始 ---
    // 尝试在 Linux 生产环境中自我守护进程化
    // 这个判断需要在任何可能绑定独占资源（如端口）的操作之前
    if (process.platform === 'linux' && !isDev && app.isPackaged && process.env[IS_DAEMONIZED_ENV_VAR] !== 'true') {
        try {
            const { spawn } = require('child_process');
            // process.argv[0] 是 process.execPath
            // process.argv.slice(1) 包含所有传递给当前实例的参数
            const args = process.argv.slice(1);
            console.log(`[DIAGNOSTIC] Attempting to daemonize on Linux... Spawning: ${process.execPath} with args: ${JSON.stringify(args)}`);

            const childEnv = { ...process.env };
            childEnv[IS_DAEMONIZED_ENV_VAR] = 'true';

            const child = spawn(process.execPath, args, {
                detached: true,
                stdio: 'ignore', // 或者 'inherit' 如果你想在某个地方看到子进程的输出（不推荐用于守护进程）
                env: childEnv
            });
            child.unref(); // 允许父进程退出

            console.log('[DIAGNOSTIC] Child process spawned for daemonization. Parent (this instance) will now quit.');
            app.quit();
            return; // 父进程退出，不执行后续的初始化
        } catch (e) {
            console.error('[DIAGNOSTIC] Failed to daemonize, continuing as foreground process:', e);
            // 如果失败，则作为普通前台进程继续
        }
    }
    console.log(`[DIAGNOSTIC] Continuing as main instance (either not Linux prod, or already daemonized, or daemonize failed).`);


    app.on('second-instance', (event, commandLineArgvOfSecondInstance, workingDirectory, additionalDataFromSecondInstance) => {
        console.log("[DIAGNOSTIC] [Primary Instance] 'second-instance' event triggered.");
        console.log(`[DIAGNOSTIC] [Primary Instance] Raw commandLineArgv from second instance: ${JSON.stringify(commandLineArgvOfSecondInstance)}`);
        console.log(`[DIAGNOSTIC] [Primary Instance] additionalDataFromSecondInstance (SHOULD BE EMPTY or DEFAULT): ${JSON.stringify(additionalDataFromSecondInstance)}`);

        if (mainConfig?.verbose) { // 使用 mainConfig 的 verbose，因为 cmdLineOptions 是属于当前（主）实例的
            console.log("[主实例] 收到 second-instance 事件。将尝试聚焦窗口（如果存在）。通知应通过HTTP接收。");
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

    let tray = null;
    let server = null;
    let udpServer = null;
    let mainConfig = null; // mainConfig 在 app.whenReady 之后才加载
    let markdownItInstance;

    try {
        const MarkdownIt = require('markdown-it');
        const markdownItKatex = require('markdown-it-katex');
        markdownItInstance = new MarkdownIt({
            html: false, linkify: true, typographer: true, breaks: true
        }).disable(['image', 'html_block', 'html_inline']);
        markdownItInstance.use(markdownItKatex, { "throwOnError": false, "errorColor": " #cc0000" });
        // verbose 日志依赖 cmdLineOptions，此时 cmdLineOptions 可能是父进程的，也可能是子进程的。
        // 如果是子进程，它会重新解析参数。
        if (cmdLineOptions?.verbose) console.log('[主进程] Markdown-it (KaTeX支持) 初始化成功。');
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

    function buildContextMenuTemplate(_mainConfig, _cmdLineOptions) { // 参数名加下划线以示区分全局
      return [
        { label: 'NovaNotif 正在运行', enabled: false },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            { label: '浅色', type: 'radio', checked: _mainConfig?.theme === 'light', click: () => ipcMain.emit('set-theme', {}, 'light') },
            { label: '深色', type: 'radio', checked: _mainConfig?.theme === 'dark', click: () => ipcMain.emit('set-theme', {}, 'dark') },
            { label: '跟随系统', type: 'radio', checked: _mainConfig?.theme === 'system', click: () => ipcMain.emit('set-theme', {}, 'system') }
          ]
        },
        { type: 'separator' },
        {
          label: '复制配置文件路径',
          click: () => {
            const cfgPath = configManager.getConfigPath();
            clipboard.writeText(cfgPath);
            if (_mainConfig?.verbose || _cmdLineOptions?.verbose) {
              console.log(`[主进程] 配置文件路径已复制到剪贴板: ${cfgPath}`);
            }
            windowController.createNotification({
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
        console.log('[DIAGNOSTIC] [Primary Instance OR Daemonized Child] app.whenReady() fired.');
        mainConfig = configManager.loadConfig();
        if (cmdLineOptions.verbose) { // 使用当前实例（可能是守护子进程）的 cmdLineOptions
            mainConfig.verbose = true;
        }
        mainConfig.currentInstanceId = SENDER_INSTANCE_ID; // 每个实例都有自己的 SENDER_INSTANCE_ID

        windowController.init(mainConfig, nativeTheme);
        daemon.init(mainConfig, windowController);

        if (mainConfig.theme === 'system') {
            nativeTheme.themeSource = 'system';
        } else if (mainConfig.theme === 'dark') {
            nativeTheme.themeSource = 'dark';
        } else {
            nativeTheme.themeSource = 'light';
        }

        createTray(); // createTray 现在依赖 mainConfig 和 cmdLineOptions
        startHttpServer();
        if (mainConfig.udp && mainConfig.udp.enabled) {
            startUdpServer(SENDER_INSTANCE_ID); // UDP 服务器也使用自己的 SENDER_INSTANCE_ID
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

        if (isNotificationCommand) { // 仅当主实例（或守护子进程）自己启动时带有通知参数
            console.log(`[DIAGNOSTIC] [Primary/Daemonized Child] Launched with initial notification command. cmdLineOptions: ${JSON.stringify(cmdLineOptions)}`);
            if (cmdLineOptions.verbose) console.log('[主实例/守护子进程] 处理来自首次启动的命令行通知:', cmdLineOptions);
            const initialNotificationData = {
                title: cmdLineOptions.title,
                content: cmdLineOptions.content,
                timeout: cmdLineOptions.timeout,
                broadcast: cmdLineOptions.broadcast || false,
            };

            windowController.createNotification(initialNotificationData);
            if (initialNotificationData.broadcast && mainConfig.udp && mainConfig.udp.enabled) {
                const broadcastPayload = { ...initialNotificationData, senderInstanceId: SENDER_INSTANCE_ID };
                daemon.broadcastNotification(broadcastPayload);
            }
        } else if (cmdLineOptions.verbose && !isNotificationAttempt) {
            console.log('[主实例/守护子进程] NovaNotif 守护进程已启动。没有初始通知命令。');
        }

        if (isDev && !isNotificationAttempt) {
            console.log('开发模式，1秒后显示测试通知...');
            setTimeout(() => {
                windowController.createNotification({
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

        // mainConfig 和 cmdLineOptions 在 createTray 调用时应该已经可用
        if (mainConfig?.verbose || cmdLineOptions?.verbose) console.log(`[主进程] 最终尝试加载托盘图标路径: ${effectiveIconPath}`);
        if (!require('fs').existsSync(effectiveIconPath)) {
            console.error(`[主进程] 错误：托盘图标文件未找到于路径: ${effectiveIconPath}`);
            console.log(`[DIAGNOSTIC] Tray icon not found at: ${effectiveIconPath}. Relevant paths: __dirname: ${__dirname}, process.resourcesPath: ${process.resourcesPath}, app.getAppPath(): ${app.getAppPath()}, app.getPath('exe'): ${app.getPath('exe')}`);
        }

        try {
            tray = new Tray(effectiveIconPath);
            // 确保 mainConfig 和 cmdLineOptions 在这里是明确的，而不是依赖外部作用域的同名变量
            const currentContextMenu = Menu.buildFromTemplate(buildContextMenuTemplate(mainConfig, cmdLineOptions));
            tray.setToolTip('NovaNotif');
            tray.setContextMenu(currentContextMenu);
            tray.on('click', () => {
                if (mainConfig?.verbose || cmdLineOptions?.verbose) console.log("托盘图标被点击。");
            });
        } catch (trayError) {
            console.error(`[主进程] 创建托盘图标失败: ${trayError.message}. 使用路径: ${effectiveIconPath}`);
        }
    }

    function startHttpServer() {
        // 确保 mainConfig 在这里可用
        if (!mainConfig) {
            console.error("[DIAGNOSTIC] mainConfig is not loaded before startHttpServer. This should not happen if called after app.whenReady.");
            mainConfig = configManager.loadConfig(); // Fallback, but investigate why
        }
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
                    console.log(`[DIAGNOSTIC] [HTTP Server] Received notification: ${JSON.stringify(notification)}`);
                    if (mainConfig?.verbose) console.log("[HTTP服务器] 收到通知请求:", notification); // cmdLineOptions?.verbose 意义不大，用 mainConfig.verbose
                    windowController.createNotification(notification);
                    if (notification.broadcast && mainConfig.udp && mainConfig.udp.enabled) {
                        const broadcastPayload = { ...notification, senderInstanceId: SENDER_INSTANCE_ID };
                        daemon.broadcastNotification(broadcastPayload);
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
                console.log(`[DIAGNOSTIC] EADDRINUSE for HTTP server, quitting app.`);
                app.quit();
            }
        });
    }

    function startUdpServer(currentInstanceId) { // currentInstanceId 是主实例或守护子进程的 SENDER_INSTANCE_ID
        if (!mainConfig) {
            console.error("[DIAGNOSTIC] mainConfig is not loaded before startUdpServer.");
            mainConfig = configManager.loadConfig();
        }
        const port = mainConfig?.udp?.port || 38081;
        udpServer = dgram.createSocket('udp4');
        udpServer.on('error', (err) => {
            console.error(`UDP服务器错误:\n${err.stack}`);
            try { udpServer.close(); } catch (e) { /* ignore */ }
        });
        udpServer.on('message', (msg, rinfo) => {
            if (mainConfig?.verbose) { // 使用 mainConfig.verbose
                console.log(`[UDP服务器] 收到来自 ${rinfo.address}:${rinfo.port} 的消息`);
            }
            try {
                const receivedNotification = JSON.parse(msg.toString());
                console.log(`[DIAGNOSTIC] [UDP Server] Received notification: ${JSON.stringify(receivedNotification)}, from: ${rinfo.address}:${rinfo.port}`);
                console.log(`[DIAGNOSTIC] [UDP Server] Current instance ID (primary/daemonized child): ${currentInstanceId}, Sender instance ID from UDP: ${receivedNotification.senderInstanceId}`);
                if (receivedNotification.senderInstanceId && receivedNotification.senderInstanceId === currentInstanceId) {
                    if (mainConfig?.verbose) {
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
                windowController.createNotification(receivedNotification);
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
        if (mainConfig?.verbose) console.log('[主进程] 所有窗口已关闭 (NovaNotif 在托盘运行)。');
    });

    app.on('before-quit', () => {
        console.log('[DIAGNOSTIC] app.before-quit event fired.');
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

    ipcMain.on('notification-mouse-enter', (event, id) => { windowController.pauseNotificationTimeout(id); });
    ipcMain.on('notification-mouse-leave', (event, id) => { windowController.resumeNotificationTimeout(id); });
    ipcMain.on('resize-notification', (event, data) => {
        if (data && typeof data.id !== 'undefined' && typeof data.height === 'number') {
            windowController.resizeNotification(data.id, data.height);
        } else {
            console.error('[主进程] IPC: resize-notification 收到无效数据:', data);
        }
    });
    ipcMain.on('user-close-notification', (event, notificationId) => {
        if (notificationId) {
            if (mainConfig?.verbose) console.log(`[主进程] IPC: user-close-notification ID: ${notificationId}`);
            windowController.closeNotification(notificationId);
        } else {
            console.error('[主进程] IPC: user-close-notification 收到无 ID 请求。');
        }
    });

    ipcMain.on('set-theme', (event, requestedTheme) => {
        if (['light', 'dark', 'system'].includes(requestedTheme)) {
            if (mainConfig?.verbose) console.log(`[主进程] 设置主题为: ${requestedTheme}`);
            if (mainConfig) mainConfig.theme = requestedTheme; // 确保 mainConfig 已加载
            configManager.saveConfig(mainConfig);

            if (requestedTheme === 'system') nativeTheme.themeSource = 'system';
            else if (requestedTheme === 'dark') nativeTheme.themeSource = 'dark';
            else nativeTheme.themeSource = 'light';

            if (tray && mainConfig && cmdLineOptions) { // 确保所有依赖都存在
                const newContextMenu = Menu.buildFromTemplate(buildContextMenuTemplate(mainConfig, cmdLineOptions));
                tray.setContextMenu(newContextMenu);
            }
        }
    });

    nativeTheme.on('updated', () => {
        // 确保 mainConfig 已加载
        if (mainConfig?.verbose) console.log('[主进程] nativeTheme 已更新。');
        const newActualTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        windowController.broadcastThemeChange(newActualTheme);
    });
}

// 将主要的应用逻辑包装在一个函数中，以便在守护进程化后可以被子进程正确执行
// 或者在非守护进程化时直接执行。
// 顶层的 `if (process.env[IS_DAEMONIZED_ENV_VAR] === 'true' || (process.platform !== 'linux' || isDev || !app.isPackaged))`
// 这种结构可能更清晰，但我们先尝试将 daemonize 逻辑放在 mainAppLogic 的开头。

// 启动应用逻辑
mainAppLogic();