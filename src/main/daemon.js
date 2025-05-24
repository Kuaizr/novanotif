// src/main/daemon.js
const dgram = require('dgram');

let config = null; 

function init(appConfig, controller) {
  config = appConfig; 
}

function broadcastNotification(notificationInput) {
  if (!config.udp || !config.udp.enabled) {
    return false;
  }

  try {
    const client = dgram.createSocket('udp4');
    const notificationToSend = { ...notificationInput };

    // senderInstanceId 应该由调用方（main/index.js）在 notificationInput 中提供
    // sharedKey 也类似，如果需要，在main/index.js中构建notificationToSend时就应该考虑
    // 或者在这里统一添加（如果逻辑如此设计）
    if (config.udp.sharedKey && !notificationToSend.key) { 
      notificationToSend.key = config.udp.sharedKey;
    }

    const message = JSON.stringify(notificationToSend);

    client.bind(() => {
      client.setBroadcast(true);
      client.send(
        message,
        0,
        message.length,
        config.udp.broadcastPort,
        config.udp.broadcastAddress,
        (err) => {
          if (err) {
            console.error('发送UDP广播时出错:', err);
          } else {
            // config.verbose 现在应该能从 mainConfig 中正确获取
            if (config.verbose) { 
                 console.log(`UDP广播已发送到 ${config.udp.broadcastAddress}:${config.udp.broadcastPort}`);
            }
          }
          client.close();
        }
      );
    });
    return true;
  } catch (error) {
    console.error('创建UDP客户端或发送广播时出错:', error);
    return false;
  }
}

module.exports = {
  init,
  broadcastNotification
};