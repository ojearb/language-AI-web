const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const TRANSCRIPTION_MODEL = "openai/gpt-transcribe";

export class OpenRouterError extends Error {
  constructor(message, { status = 502, details } = {}) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.details = details;
  }
}

export async function generateAssistantResponse(messages, config) {
  const body = await openRouterRequest('/chat/completions', {
    model: config.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
  }, config);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new OpenRouterError("OpenRouter returned an empty or invalid response.");
  }
  return content;
}

export async function transcribeAudio(inputAudio, config) {
  const body = await openRouterRequest('/audio/transcriptions', {
    model: TRANSCRIPTION_MODEL,
    input_audio: inputAudio,
    response_format: 'json',
  }, config);
  if (typeof body.text !== 'string' || !body.text.trim()) {
    throw new OpenRouterError('No speech was transcribed. Try recording your answer again.');
  }
  return body.text.trim();
}

async function openRouterRequest(endpoint, payload, config) {
  if (!config.apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not configured.", { status: 503 });
  }
  if (!payload.model) {
    throw new OpenRouterError("OPENROUTER_MODEL is not configured.", { status: 503 });
  }

  let response;
  try {
    response = await fetch(`${(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(config.appUrl ? { "HTTP-Referer": config.appUrl } : {}),
        ...(config.appName ? { "X-Title": config.appName } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new OpenRouterError("OpenRouter did not respond before the request timed out.", {
        status: 504,
      });
    }
    throw new OpenRouterError("Could not connect to OpenRouter.", {
      details: error.message,
    });
  }

  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = {};
  }

  if (!response.ok || body.error) {
    throw new OpenRouterError(
      body.error?.message || `OpenRouter returned HTTP ${response.status}.`,
      {
        status: response.status === 429 ? 429 : 502,
        details: body.error?.metadata,
      },
    );
  }

  return body;
}
