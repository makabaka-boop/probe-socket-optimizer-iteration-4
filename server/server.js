import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { NoPerfectAssignmentError } from './hungarian.js';
import { analyzeMandatoryPairs } from './mandatory.js';
import { validateCosts } from './validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 25 * 1024 * 1024, // n=400 的 JSON 约 20MB
  });

  // JSON 语法错误等请求类错误统一为 422 / INVALID_INPUT。
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(422).send({
        status: 'error',
        error: 'INVALID_INPUT',
        message: error.message,
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      status: 'error',
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post('/api/solve', async (request, reply) => {
    const result = validateCosts(request.body);
    if (!result.ok) {
      return reply.status(422).send({
        status: 'error',
        error: 'INVALID_INPUT',
        message: result.reason,
      });
    }

    try {
      // 同一次求解内完成最优匹配与必然连线分析：求解器可任选一个最优配对，
      // pairFlags 严格对应下方返回（即页面展示）的这一组配对。
      const { assignment, totalCost, pairFlags } = analyzeMandatoryPairs(request.body.costs);
      return reply.send({
        status: 'ok',
        n: result.n,
        assignment, // assignment[i] = 第 i 行（探针）匹配的列（测试座），0 基下标
        totalCost, // 精确整数，可由 assignment 对原矩阵直接复算
        // 与 assignment 逐行对齐：forced=该连线出现在所有最优完美匹配中；
        // alternatives=该探针在最优解中可改配的其他列数（forced 时为 0）。
        pairFlags,
      });
    } catch (err) {
      if (err instanceof NoPerfectAssignmentError) {
        return reply.status(409).send({
          status: 'error',
          error: 'NO_PERFECT_ASSIGNMENT',
          message: '禁配关系下不存在覆盖全部探针与测试座的完美匹配',
        });
      }
      throw err;
    }
  });

  // 生产环境托管 Vite 构建产物。
  if (existsSync(DIST_DIR)) {
    await app.register(fastifyStatic, { root: DIST_DIR });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url && request.raw.url.startsWith('/api/')) {
        return reply.status(404).send({
          status: 'error',
          error: 'NOT_FOUND',
          message: '接口不存在',
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildServer()
    .then((app) => app.listen({ port: PORT, host: HOST }))
    .then((address) => {
      console.log(`探针分配服务已启动: ${address}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
