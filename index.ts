import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = new Hono();

// Middleware to inject CORS or other things if needed
app.use('*', async (c, next) => {
  await next();
});

// --- Cloudflare API Handlers ---

app.get('/api/workers/:name', async (c) => {
  const name = c.req.param('name');
  const accountId = c.req.query('accountId');
  const token = c.req.header('Authorization');
  const email = c.req.header('X-Auth-Email');

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`, {
      headers: {
        'Authorization': token!,
        'X-Auth-Email': email || '',
      }
    });
    // The script content is returned directly as a string, not JSON
    const code = await response.text();
    return c.json({ success: true, code });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/workers', async (c) => {
  const accountId = c.req.query('accountId');
  const token = c.req.header('Authorization');
  const email = c.req.header('X-Auth-Email');

  if (!accountId || !token) return c.json({ success: false, error: 'Missing credentials' }, 401);

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
      headers: {
        'Authorization': token,
        'X-Auth-Email': email || '',
        'Content-Type': 'application/json'
      }
    });
    const data: any = await response.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.delete('/api/workers/:name', async (c) => {
  const name = c.req.param('name');
  const accountId = c.req.query('accountId');
  const token = c.req.header('Authorization');
  const email = c.req.header('X-Auth-Email');

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`, {
      method: 'DELETE',
      headers: {
        'Authorization': token!,
        'X-Auth-Email': email || '',
      }
    });
    const data: any = await response.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.post('/api/workers/deploy', async (c) => {
  const { name, code, accountId } = await c.req.json();
  const token = c.req.header('Authorization');
  const email = c.req.header('X-Auth-Email');

  try {
    // Cloudflare Workers Script upload
    // We send as a single script (service worker format or ES module)
    const isModule = code.includes('export default');
    let response;

    if (isModule) {
      const formData = new FormData();
      const metadata = {
        main_module: 'index.js',
      };
      formData.append('metadata', JSON.stringify(metadata));
      formData.append('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');

      response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`, {
        method: 'PUT',
        headers: {
          'Authorization': token!,
          'X-Auth-Email': email || '',
        },
        body: formData
      });
    } else {
      response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`, {
        method: 'PUT',
        headers: {
          'Authorization': token!,
          'X-Auth-Email': email || '',
          'Content-Type': 'application/javascript'
        },
        body: code
      });
    }

    const data: any = await response.json();

    if (data.success) {
        // Also enable the workers.dev subdomain for it
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
            method: 'POST',
            headers: {
                'Authorization': token!,
                'X-Auth-Email': email || '',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enabled: true })
        });
    }

    return c.json(data);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.post('/api/workers/domain', async (c) => {
  const { name, domain, accountId, zoneId } = await c.req.json();
  const token = c.req.header('Authorization');
  const email = c.req.header('X-Auth-Email');

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`, {
      method: 'PUT',
      headers: {
        'Authorization': token!,
        'X-Auth-Email': email || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        environment: "production",
        hostname: domain,
        service: name,
        zone_id: zoneId
      })
    });

    const data: any = await response.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// --- Gemini AI Handlers ---

app.post('/api/ai/generate', async (c) => {
  const { prompt, model, geminiKey, existingCode } = await c.req.json();

  let modelId = model || "gemini-1.5-flash";

  const genAI = new GoogleGenerativeAI(geminiKey);
  const aiModel = genAI.getGenerativeModel({ model: modelId });

  const systemPrompt = `You are an expert Cloudflare Workers developer.
Generate a high-quality, production-ready, modern and sophisticated Cloudflare Worker script based on the user's request.
Return ONLY the code, no markdown markers like \`\`\`javascript or \`\`\`typescript.
The code should be a single file. Use ES modules (export default { fetch... }) if possible.
IMPORTANT: Do NOT use any external imports or libraries like 'hono'. Use ONLY native Cloudflare Workers APIs.
The code must be self-contained and ready to run without a bundler.
User Request: ${prompt}
${existingCode ? `Existing Code to refine: ${existingCode}` : ''}
`;

  return streamText(c, async (stream) => {
    try {
      const result = await aiModel.generateContentStream(systemPrompt);
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        // Simple cleanup for common markdown artifacts if they appear mid-stream
        const cleaned = chunkText.replace(/```(?:javascript|typescript|js|ts)?\n?/g, '').replace(/```/g, '');
        await stream.write(cleaned);
      }
    } catch (error: any) {
      await stream.write(`ERROR: ${error.message}`);
    }
  });
});

app.post('/api/ai/fix', async (c) => {
  const { error, code, model, geminiKey } = await c.req.json();

  let modelId = model || "gemini-1.5-flash";

  const genAI = new GoogleGenerativeAI(geminiKey);
  const aiModel = genAI.getGenerativeModel({ model: modelId });

  const systemPrompt = `The following Cloudflare Worker code failed to deploy or has an error.
You are a Cloudflare Workers expert. Fix the code to resolve the error.
Error: ${error}
Code:
${code}

IMPORTANT: Do NOT use any external imports or libraries like 'hono'. Use ONLY native Cloudflare Workers APIs.
Return ONLY the corrected code, no markdown markers.`;

  return streamText(c, async (stream) => {
    try {
      const result = await aiModel.generateContentStream(systemPrompt);
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        const cleaned = chunkText.replace(/```(?:javascript|typescript|js|ts)?\n?/g, '').replace(/```/g, '');
        await stream.write(cleaned);
      }
    } catch (err: any) {
      await stream.write(`ERROR: ${err.message}`);
    }
  });
});

// Static files (Vite build)
app.get('/*', async (c) => {
  const res = await (c.env as any).ASSETS.fetch(c.req.raw);
  if (res.status === 404) {
    // Return index.html for SPA routing if needed
    return (c.env as any).ASSETS.fetch(new Request(new URL('/', c.req.url)));
  }
  return res;
});

export default app;
