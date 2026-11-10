import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";

export const DEFAULT_MODEL_ID = "ca.amazon.nova-lite-v1:0";
export const MODEL_TEMPERATURE = 0.1;
export const MODEL_TIMEOUT_MS = 20_000;

export type ModelErrorKind = "model_error" | "timeout" | "throttled";

/** Typed failure from the model layer. The message is a fixed label, never model or user text. */
export class ModelError extends Error {
  constructor(readonly kind: ModelErrorKind) {
    super(kind);
    this.name = "ModelError";
  }
}

export interface BedrockLike {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the tool input. */
  schema: Record<string, unknown>;
}

export interface ConverseToolArgs {
  client: BedrockLike;
  modelId: string;
  system: string;
  user: string;
  tool: ToolDef;
  maxTokens: number;
  timeoutMs?: number;
}

export interface ConverseToolResult {
  input: unknown;
  inputTokens: number;
  outputTokens: number;
}

export function createClient(region: string | undefined): BedrockLike {
  return new BedrockRuntimeClient({ region: region ?? "ca-central-1", maxAttempts: 2 }) as unknown as BedrockLike;
}

function classify(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  const name = err?.name ?? "";
  const status = err?.$metadata?.httpStatusCode;
  if (name === "ThrottlingException" || name === "TooManyRequestsException" || status === 429) {
    return new ModelError("throttled");
  }
  if (name === "AbortError" || name === "TimeoutError" || name === "ModelTimeoutException" || status === 504) {
    return new ModelError("timeout");
  }
  return new ModelError("model_error");
}

/** One Converse call with a forced tool, returning the parsed tool input. */
export async function converseTool(args: ConverseToolArgs): Promise<ConverseToolResult> {
  const timeoutMs = args.timeoutMs ?? MODEL_TIMEOUT_MS;
  if (timeoutMs <= 0) throw new ModelError("timeout");
  const request: ConverseCommandInput = {
    modelId: args.modelId,
    system: [{ text: args.system }],
    messages: [{ role: "user", content: [{ text: args.user }] }],
    inferenceConfig: { maxTokens: args.maxTokens, temperature: MODEL_TEMPERATURE },
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: args.tool.name,
            description: args.tool.description,
            inputSchema: { json: args.tool.schema as never },
          },
        },
      ],
      toolChoice: { tool: { name: args.tool.name } },
    },
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelError("timeout"));
    }, timeoutMs);
  });
  try {
    const response = (await Promise.race([
      args.client.send(new ConverseCommand(request), { abortSignal: controller.signal }),
      timeout,
    ])) as {
      output?: { message?: { content?: Array<{ toolUse?: { name?: string; input?: unknown } }> } };
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const block = response?.output?.message?.content?.find((c) => c?.toolUse?.name === args.tool.name);
    if (!block?.toolUse || block.toolUse.input === undefined) throw new ModelError("model_error");
    return {
      input: block.toolUse.input,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  } catch (e) {
    throw classify(e);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
