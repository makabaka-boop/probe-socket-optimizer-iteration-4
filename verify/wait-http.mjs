// 轮询健康检查接口直到 web 服务就绪（供 verify 容器启动时使用）。
const url = process.argv[2];
if (!url) {
  console.error('用法: node wait-http.mjs <health-url>');
  process.exit(2);
}
const deadline = Date.now() + 60_000;
async function ping() {
  try {
    const r = await fetch(url);
    if (r.ok) return true;
  } catch {
    /* 服务尚未就绪 */
  }
  return false;
}
const timer = setInterval(async () => {
  if (await ping()) {
    clearInterval(timer);
    console.log(`目标服务已就绪: ${url}`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    console.error(`等待超时: ${url}`);
    process.exit(1);
  }
}, 500);
