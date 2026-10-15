const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '', tooLarge = false;
    request.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 8_192) {
        tooLarge = true;
      }
    });
    request.on('end', () => {
      if (tooLarge) return reject(new Error('Request is too large.'));
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON.')); }
    });
    request.on('error', reject);
  });
}

async function suggestSubtasks(request, response) {
  if (!apiKey) return sendJson(response, 503, { error: 'AI suggestions need an OPENAI_API_KEY. See the README setup instructions.' });
  let input;
  try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
  if (!title) return sendJson(response, 400, { error: 'Enter a task name first.' });

  let apiResponse;
  try {
    apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: 'Break the task into 3 to 6 clear, concrete, low-friction subtasks. Use short action phrases, in a sensible order. Make steps small enough to start without extra planning. Do not add dates or times. If the task is already a single small action, return one helpful step. Return only the required structured data.',
        input: `Task: ${title}\nList: ${String(input.list || 'Personal').slice(0, 40)}\nEnergy: ${String(input.energy || 'medium').slice(0, 20)}\nDue date: ${String(input.dueDate || 'unscheduled').slice(0, 20)}`,
        max_output_tokens: 300,
        text: {
          format: {
            type: 'json_schema',
            name: 'task_breakdown',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { steps: { type: 'array', items: { type: 'string' } } },
              required: ['steps']
            }
          }
        }
      })
    });
  } catch {
    console.error('OpenAI request failed before receiving a response. Check network access and try again.');
    return sendJson(response, 502, { error: 'Could not reach the suggestion service. Check your connection and try again.' });
  }

  const result = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const code = result.error?.code || result.error?.type || `http_${apiResponse.status}`;
    console.error(`OpenAI API error (${apiResponse.status}): ${code}`);
    let message = 'The suggestion service could not make a breakdown right now.';
    if (apiResponse.status === 401 || apiResponse.status === 403) message = 'The OpenAI API key was rejected or lacks access. Check the key, then restart the server.';
    else if (apiResponse.status === 429 && ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].includes(code)) message = `OpenAI API billing or usage limit reached (${code}). Check the API project’s billing and limits.`;
    else if (apiResponse.status === 429 && code === 'slow_down') {
      const retryAfter = apiResponse.headers.get('retry-after');
      message = retryAfter ? `OpenAI asked us to slow down. Wait at least ${retryAfter} seconds before trying again.` : 'OpenAI asked us to slow down. Wait a little longer before trying again.';
    }
    else if (apiResponse.status === 429) {
      const retryAfter = apiResponse.headers.get('retry-after');
      message = retryAfter ? `OpenAI’s request limit was reached. Wait at least ${retryAfter} seconds before trying again.` : 'OpenAI’s request limit was reached. Check the project’s model rate limits and try again later.';
    }
    else if (apiResponse.status === 400 || apiResponse.status === 404) message = `OpenAI rejected this request (${code}). Check the configured model (${model}) and try again.`;
    return sendJson(response, 502, { error: message });
  }
  const outputText = result.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!outputText) return sendJson(response, 502, { error: 'The model did not return any steps. Try again.' });
  try {
    const steps = JSON.parse(outputText).steps;
    if (!Array.isArray(steps)) throw new Error('Invalid suggestion data.');
    return sendJson(response, 200, { steps: steps.map(step => String(step).trim()).filter(Boolean).slice(0, 6) });
  } catch {
    return sendJson(response, 502, { error: 'The model returned an unreadable breakdown. Try again.' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/suggest-subtasks' && request.method === 'POST') return suggestSubtasks(request, response);
  if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'API route not found.' });
  if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed.' });

  let filePath;
  try { filePath = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`); }
  catch { response.writeHead(400); return response.end('Bad request'); }
  if (filePath !== root && !filePath.startsWith(root + path.sep)) { response.writeHead(403); return response.end('Forbidden'); }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).pipe(response);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`SlashTasks running at http://127.0.0.1:${port}`);
  if (!apiKey) console.log('AI suggestions are disabled until OPENAI_API_KEY is set.');
});
