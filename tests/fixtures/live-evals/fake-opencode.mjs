#!/usr/bin/env node
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
if (args[0] !== 'serve' || args[1] !== '--hostname' || args[2] !== '127.0.0.1'
  || portIndex === -1 || !Number.isInteger(Number(args[portIndex + 1]))) {
  process.exit(2);
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

function send(response, status, value) {
  const body = value === null ? '' : JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/global/health') {
    send(response, 200, { healthy: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/session') {
    send(response, 200, { id: 'fake-root' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/session/fake-root/message') {
    const body = await jsonBody(request);
    if (process.env.NARU_FAKE_HANG === '1') return;
    const prompt = JSON.parse(body.parts[0].text);
    send(response, 200, {
      info: { cost: 0, tokens: { input: 1, output: 1 } },
      naruEvaluation: { rubric: prompt.input.rubricIds.map((id) => ({ id, passed: true })) },
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/session') {
    send(response, 200, [{ id: 'fake-root' }]);
    return;
  }
  if (request.method === 'DELETE' && url.pathname === '/session/fake-root') {
    send(response, 200, null);
    return;
  }
  send(response, 404, { error: 'not-found' });
});

server.listen(Number(args[portIndex + 1]), '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', process.env.NARU_FAKE_IGNORE_SIGTERM === '1' ? () => {} : stop);
process.once('SIGINT', stop);
