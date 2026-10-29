import express from "express";
import { generateAssistantResponse, transcribeAudio, TRANSCRIPTION_MODEL, OpenRouterError } from "./openrouter.js";
import { buildReviewMessages } from "./review.js";

export function createApp({ store, openRouterConfig }) {
  const app = express();

  app.disable("x-powered-by");
  app.use('/api/conversations/:id/transcriptions', express.json({ limit: '36mb' }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", model: openRouterConfig.model || null, transcriptionModel: TRANSCRIPTION_MODEL });
  });

  app.get("/api/configurations", (_request, response) => {
    response.json({ configurations: store.listConfigurations() });
  });

  app.post("/api/configurations", async (request, response, next) => {
    try {
      const settings = normalizeConfiguration(request.body);
      if (settings.error) return response.status(400).json({ error: settings.error });
      const configuration = await store.createConfiguration(settings.value);
      return response.status(201).json({ configuration });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/configurations/:id", (request, response) => {
    const configuration = store.getConfiguration(request.params.id);
    if (!configuration) {
      return response.status(404).json({ error: "Chat configuration not found." });
    }
    return response.json({ configuration });
  });

  app.put("/api/configurations/:id", async (request, response, next) => {
    try {
      const settings = normalizeConfiguration(request.body);
      if (settings.error) return response.status(400).json({ error: settings.error });
      const configuration = await store.updateConfiguration(request.params.id, settings.value);
      if (!configuration) {
        return response.status(404).json({ error: "Chat configuration not found." });
      }
      return response.json({ configuration });
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/configurations/:id", async (request, response, next) => {
    try {
      const deleted = await store.deleteConfiguration(request.params.id);
      if (!deleted) {
        return response.status(404).json({ error: "Chat configuration not found." });
      }
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/configurations/:id/conversations", (request, response) => {
    if (!store.getConfiguration(request.params.id)) {
      return response.status(404).json({ error: "Chat configuration not found." });
    }
    return response.json({ conversations: store.listConversations(request.params.id) });
  });

  app.post("/api/configurations/:id/start", async (request, response, next) => {
    try {
      const configuration = store.getConfiguration(request.params.id);
      if (!configuration) {
        return response.status(404).json({ error: "Chat configuration not found." });
      }

      const assistantContent = await generateAssistantResponse(
        [{ role: 'system', content: 'When generating a set of practice exercises, put each independently answerable exercise in a separate paragraph, separated by a blank line. A translation sentence is an exercise even if it is a statement. Keep all parts of a single exercise together, such as a location and its start/end times, or a dialogue and its requested reply. Follow the user\'s requested language and content; do not add labels, hints, translations, or answers unless requested.' },
          { role: "user", content: configuration.prompt }],
        openRouterConfig,
      );
      const conversation = await store.createConversation(
        configuration.id,
        configuration.prompt,
        assistantContent,
      );
      return response.status(201).json({ conversation });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/conversations/:id", (request, response) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) {
      return response.status(404).json({ error: "Conversation not found." });
    }
    return response.json({ conversation });
  });

  app.delete("/api/conversations/:id", async (request, response, next) => {
    try {
      const deleted = await store.deleteConversation(request.params.id);
      if (!deleted) {
        return response.status(404).json({ error: "Conversation not found." });
      }
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/conversations/:id/messages", async (request, response, next) => {
    try {
      const content = normalizeText(request.body?.content, 50_000);
      if (!content) {
        return response.status(400).json({ error: "Message content must be a non-empty string." });
      }

      const conversation = store.getConversation(request.params.id);
      if (!conversation) {
        return response.status(404).json({ error: "Conversation not found." });
      }

      const assistantContent = await generateAssistantResponse(
        [...conversation.messages, { role: "user", content }],
        openRouterConfig,
      );
      const saved = await store.appendExchange(request.params.id, content, assistantContent);
      if (!saved) {
        return response.status(404).json({ error: "Conversation not found." });
      }
      return response.status(201).json({ conversation: saved.conversation });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/conversations/:id/transcriptions', async (request, response, next) => {
    try {
      if (!store.getConversation(request.params.id)) {
        return response.status(404).json({ error: 'Conversation not found.' });
      }
      const { data, format } = request.body?.inputAudio ?? {};
      if (!['webm', 'm4a', 'mp4', 'ogg', 'wav', 'mp3', 'flac', 'aac'].includes(format)) {
        return response.status(400).json({ error: 'Unsupported recording format.' });
      }
      if (typeof data !== 'string' || !data.length || data.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        return response.status(400).json({ error: 'Audio must be non-empty base64-encoded data.' });
      }
      if (Buffer.byteLength(data, 'base64') > 25 * 1024 * 1024) {
        return response.status(413).json({ error: 'Recordings must be smaller than 25 MB.' });
      }
      const text = await transcribeAudio({ data, format }, openRouterConfig);
      return response.json({ text, model: TRANSCRIPTION_MODEL });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/conversations/:id/reviews', async (request, response, next) => {
    try {
      const conversation = store.getConversation(request.params.id);
      if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
      const question = conversation.questions.find((item) => item.id === request.body?.questionId);
      if (!question) return response.status(400).json({ error: 'Choose a generated question from this conversation.' });
      const answer = request.body?.answer;
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 50_000) {
        return response.status(400).json({ error: 'Answer must contain between 1 and 50,000 characters.' });
      }
      const configuration = store.getConfiguration(conversation.configurationId);
      const feedback = await generateAssistantResponse(buildReviewMessages({
        configuration, conversation, question, answer: answer.trim(),
      }), openRouterConfig);
      const saved = await store.appendExchange(conversation.id,
        `Question: ${question.text}\n\nMy answer: ${answer.trim()}`, feedback,
        { kind: 'answer-review', questionId: question.id, question: question.text, answer: answer.trim() });
      if (!saved) return response.status(404).json({ error: 'Conversation not found.' });
      return response.status(201).json({ conversation: saved.conversation, feedback });
    } catch (error) {
      return next(error);
    }
  });

  app.use((request, response) => {
    response.status(404).json({ error: `Route not found: ${request.method} ${request.path}` });
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof OpenRouterError) {
      return response.status(error.status).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return response.status(400).json({ error: "Request body contains invalid JSON." });
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'The request is too large. Recordings must be smaller than 25 MB.' });
    }
    console.error(error);
    return response.status(500).json({ error: "Internal server error." });
  });

  return app;
}

function normalizeConfiguration(body) {
  const name = normalizeText(body?.name, 100);
  const prompt = normalizeText(body?.prompt, 50_000);
  const category = normalizeText(body?.category, 80);
  if (body?.evaluationPrompt !== undefined && (typeof body.evaluationPrompt !== 'string'
    || !body.evaluationPrompt.trim() || body.evaluationPrompt.length > 50_000)) {
    return { error: 'Answer evaluation prompt must contain between 1 and 50,000 characters.' };
  }
  if (!name) return { error: "Name must be a non-empty string." };
  if (!prompt) return { error: "Prompt must be a non-empty string." };
  if (typeof body?.saveChats !== "boolean") {
    return { error: "Save chats must be true or false." };
  }
  return { value: { name, prompt, saveChats: body.saveChats, category,
    evaluationPrompt: body.evaluationPrompt === undefined ? undefined : body.evaluationPrompt.trim() } };
}

function normalizeText(value, maximumLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maximumLength);
}
