import readline from 'node:readline';

const endpoint = process.env.QUOTA_HUB_MCP_URL || 'http://127.0.0.1:8786/mcp';
const token = process.env.MCP_AUTH_TOKEN || '';
let sessionId = '';
let queue = Promise.resolve();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function forward(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message) });
    const nextSession = response.headers.get('mcp-session-id');
    if (nextSession) sessionId = nextSession;
    const text = await response.text();
    if (text) {
      try { writeMessage(JSON.parse(text)); } catch { writeMessage({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'Invalid MCP response' } }); }
    } else if (!response.ok && message.id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: `MCP HTTP ${response.status}` } });
    }
  } catch (error) {
    if (message.id !== undefined) writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: `Unable to reach ${endpoint}: ${error?.message || 'network error'}` } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  queue = queue.then(() => forward(message));
});
input.on('close', () => { void queue; });
