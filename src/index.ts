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
import type { Part } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  OPENCODE_CONFIG
} from './opencode-config';

export { ContainerProxy };

export class Sandbox extends BaseSandbox<Env> {}

const SANDBOX_ID = 'opencode';
const WORKSPACE_DIRECTORY = '/opt/repos/opencode-cloud';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

    if (request.method === 'POST' && url.pathname === '/api/test') {
      return handleSdkTest(sandbox);
    }

    const server = await createOpencodeServer(sandbox, {
      directory: WORKSPACE_DIRECTORY,
      config: OPENCODE_CONFIG
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
      config: OPENCODE_CONFIG
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
        providerID: DEFAULT_PROVIDER_ID,
        modelID: DEFAULT_MODEL_ID
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
