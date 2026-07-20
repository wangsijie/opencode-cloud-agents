/**
 * OpenCode + Cloudflare Sandbox experiment.
 *
 * Based on cloudflare/sandbox-sdk/examples/opencode. It supports both the full
 * OpenCode web UI at / and programmatic SDK access at POST /api/test.
 */
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox
} from '@cloudflare/sandbox';
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode
} from '@cloudflare/sandbox/opencode';
import type { Config, Part } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';

export { ContainerProxy };

export class Sandbox extends BaseSandbox<Env> {
  interceptHttps = true;
}

const SANDBOX_ID = 'opencode';
const WORKSPACE_DIRECTORY = '/home/user/agents';
const PROXY_INJECTED_API_KEY = 'proxy-injected';
const PROVIDER_ID = 'vwnpc';
const MODEL_ID = 'grok-4.5';
const MODEL = `${PROVIDER_ID}/${MODEL_ID}`;
const VWNPC_ORIGIN = 'https://ai.vwnpc.com';
const VWNPC_PROXY_BASE_URL = `${VWNPC_ORIGIN}/v1`;

function getRequestBody(request: Request): ReadableStream | null | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  return request.body;
}

function buildTargetUrl(request: Request, origin: string): string {
  const url = new URL(request.url);
  return `${origin}${url.pathname}${url.search}`;
}

Sandbox.outboundByHost = {
  'ai.vwnpc.com': async (request: Request, env: Env) => {
    if (!env.VWNPC_API_KEY) {
      return new Response('VWNPC_API_KEY is not configured', {
        status: 500
      });
    }

    const headers = new Headers(request.headers);
    headers.set('x-api-key', env.VWNPC_API_KEY);
    headers.delete('authorization');

    return fetch(buildTargetUrl(request, VWNPC_ORIGIN), {
      method: request.method,
      headers,
      body: getRequestBody(request)
    });
  }
};

const getConfig = (): Config => ({
  model: MODEL,
  small_model: MODEL,
  provider: {
    [PROVIDER_ID]: {
      npm: '@ai-sdk/anthropic',
      name: 'VW NPC (Grok)',
      options: {
        apiKey: PROXY_INJECTED_API_KEY,
        baseURL: VWNPC_PROXY_BASE_URL
      },
      models: {
        [MODEL_ID]: {
          name: 'Grok 4.5',
          limit: {
            context: 500000,
            output: 65536
          }
        }
      }
    }
  }
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

    if (request.method === 'POST' && url.pathname === '/api/test') {
      return handleSdkTest(sandbox);
    }

    const server = await createOpencodeServer(sandbox, {
      directory: WORKSPACE_DIRECTORY,
      config: getConfig()
    });

    return proxyToOpencode(request, sandbox, server);
  }
};

async function handleSdkTest(
  sandbox: ReturnType<typeof getSandbox>
): Promise<Response> {
  try {
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: WORKSPACE_DIRECTORY,
      config: getConfig()
    });

    const session = await client.session.create({
      title: 'Test Session',
      directory: WORKSPACE_DIRECTORY
    });

    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    const promptResult = await client.session.prompt({
      sessionID: session.data.id,
      directory: WORKSPACE_DIRECTORY,
      model: {
        providerID: PROVIDER_ID,
        modelID: MODEL_ID
      },
      parts: [
        {
          type: 'text',
          text: 'Summarize the README.md file in 2-3 sentences. Be concise.'
        }
      ]
    });

    const parts = promptResult.data?.parts ?? [];
    const textPart = parts.find(
      (part): part is Part & { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string'
    );

    return new Response(textPart?.text ?? 'No response', {
      headers: { 'Content-Type': 'text/plain' }
    });
  } catch (error) {
    console.error('SDK test error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;

    return Response.json(
      { success: false, error: message, stack },
      { status: 500 }
    );
  }
}
