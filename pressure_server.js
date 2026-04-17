/*****************************
 *        端口配置区         *
 ​*****************************/
const HTTPS_PORT = 4000;
const HTTP_PORT = 3000;
const CERT = {
  key: './cert/key.pem',
  cert: './cert/cert.pem'
};
const MAX_BODY_LENGTH = 1024 * 1024; // 1MB请求体限制（可根据需求调整）

/*****************************
 *        核心逻辑区         *
 ​*****************************/
const https = require('https');
const http = require('http');
const fs = require('fs');

// 初始化汉字池
const charPool = [];
for (let code = 0x4E00; code <= 0x9FFF; code++) charPool.push(String.fromCharCode(code));
for (let code = 0x3400; code <= 0x4DBF; code++) charPool.push(String.fromCharCode(code));

// 创建 HTTPS 服务器
const httpsServer = https.createServer({
  key: fs.readFileSync(CERT.key),
  cert: fs.readFileSync(CERT.cert)
}, async (req, res) => {
  handleRequest(req, res, true);
});

// 创建 HTTP 重定向服务器
const httpServer = http.createServer((req, res) => {
  res.writeHead(301, { 
    Location: `https://${req.headers.host.replace(/:\d+$/, '')}:${HTTPS_PORT}${req.url}` 
  });
  res.end();
});


/*****************************
 *      请求体处理工具类       *
 ​*****************************/
class BodyCollector {
  constructor(maxLength) {
    this.buffer = Buffer.alloc(0);
    this.actualLength = 0;
    this.maxLength = maxLength;
    this.isTruncated = false;
    this.truncationReported = false; // 截断日志标记
  }

  append(chunk) {
    const remaining = this.maxLength - this.actualLength;

    // 处理块级截断逻辑
    if (remaining <= 0) {
      this.isTruncated = true;
      if (!this.truncationReported) {
        console.warn(`[截断告警] 请求体超过最大限制，已截断前 ${this.maxLength} 字节`);
        this.truncationReported = true;
      }
      return;
    }

    // 处理块内部分截断
    const validChunk = chunk.slice(0, remaining);
    this.buffer = Buffer.concat([this.buffer, validChunk], this.maxLength);
    this.actualLength += validChunk.length;

    // 块尾部截断检测
    if (validChunk.length < chunk.length) {
      this.isTruncated = true;
      if (!this.truncationReported) {
        console.warn(`[截断告警] 请求体超过最大限制，已截断前 ${this.maxLength} 字节`);
        this.truncationReported = true;
      }
    }
  }

  getResult() {
    return {
      body: this.buffer.toString(),
      isTruncated: this.isTruncated,
      receivedBytes: this.actualLength
    };
  }
}

/*****************************
 *        业务逻辑区         *
 ​*****************************/
async function handleRequest(req, res, isHttps) {
  const clientInfo = {
    ip: req.socket.remoteAddress.replace(/^::ffff:/, ''),
    port: req.socket.remotePort,
    toString() { return `[${this.ip}:${this.port}]`; }
  };

  console.log(`${clientInfo} 访问 ${isHttps ? 'HTTPS' : 'HTTP'} ${req.method} ${req.url}`);

  try {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Method Not Allowed');
    }

    // 安全收集请求体（带截断处理）
    const bodyCollector = new BodyCollector(MAX_BODY_LENGTH);
    await new Promise(resolve => {
      req.on('data', chunk => {
        // 实时处理数据块
        bodyCollector.append(chunk);
        // 添加调试日志（可选）
        // console.log(`${clientInfo} 接收分块 ${chunk.length} 字节，已累积 ${bodyCollector.actualLength} 字节`);
      });
      req.on('end', resolve);
    });

    // 获取处理结果
    const { body, isTruncated, receivedBytes } = bodyCollector.getResult();
    console.log(`${clientInfo} 接收 ${receivedBytes} 字节${isTruncated ? ' (已截断)' : ''}`);

    // 路由处理
    if (req.url === '/deepseek-r1-tx/v1/chat') {
      await handleStreamResponse(clientInfo, res, body, isTruncated);
    } else if (req.url === '/deepseek-r1-tx/v1/chat/completions') {
      await handleFullResponse(clientInfo, res, body, isTruncated);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch (err) {
    console.error(`${clientInfo} 处理失败:`, err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

/*****************************
 *      流式响应处理增强       *
 ​*****************************/
async function handleStreamResponse(clientInfo, res, bodyStr, isTruncated) {
  console.log(`${clientInfo} 流式处理请求 (原始长度: ${bodyStr.length})`);

  // 设置 SSE 流式响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 生成流式元数据
  const streamId = `stream_${Date.now()}`;
  const baseLength = Math.max(10, bodyStr.length); // 防止空请求体
  const totalChars = Math.floor(baseLength * (1 + Math.random() * 9)); // 1-10倍长度

  // 发送初始元数据
  res.write(`event: init\ndata: ${
    JSON.stringify({
      id: streamId,
      total: totalChars,
      truncated: isTruncated  // 暴露截断状态给客户端
    })
  }\n\n`);

  let sentCount = 0;
  const sendChunk = () => {
    if (sentCount >= totalChars) {
      res.write(`event: end\ndata: {"id": "${streamId}"}\n\n`);
      res.end();
      console.log(`${clientInfo} 流式响应完成`);
      return;
    }

    // 构建数据块
    const chunkData = JSON.stringify({
      id: streamId,
      index: sentCount,
      data: charPool[Math.floor(Math.random() * charPool.length)],
      truncated: isTruncated
    });

    res.write(`data: ${chunkData}\n\n`);
    sentCount++;

    // 流速控制（50ms/字符）
    setTimeout(sendChunk, 50);
  };

  sendChunk();
}

/*****************************
 *      完整响应处理增强       *
 ​*****************************/
async function handleFullResponse(clientInfo, res, bodyStr, isTruncated) {
  console.log(`${clientInfo} 完整处理请求 (原始长度: ${bodyStr.length})`);

  // 生成响应内容
  const baseLength = Math.max(10, bodyStr.length);
  const responseLength = Math.floor(baseLength * (1 + Math.random() * 9));
  const content = Array.from({ length: responseLength },
    () => charPool[Math.floor(Math.random() * charPool.length)]).join('');

  // 设置响应头
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Request-Truncated', isTruncated.toString());

  // 返回结构化响应
  const response = {
    content: content,
    meta: {
      request_length: bodyStr.length,
      response_length: responseLength,
      truncated: isTruncated
    }
  };

  const responseData = JSON.stringify(response);
  res.setHeader('Content-Length', Buffer.byteLength(responseData));
  res.end(responseData);
  console.log(`${clientInfo} 已发送 ${responseLength} 字符的响应`);
}


/*****************************
 *        服务启动区         *
 ​*****************************/
httpsServer.listen(HTTPS_PORT, () => {
  console.log(`HTTPS 服务运行在 ${HTTPS_PORT} 端口`);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP 重定向服务运行在 ${HTTP_PORT} 端口`);
});

// 全局错误处理
process.on('uncaughtException', (err) => {
  console.error('全局异常:', err);
});

