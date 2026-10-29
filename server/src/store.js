import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withQuestions } from "./questions.js";
import { DEFAULT_EVALUATION_PROMPT, LEGACY_EVALUATION_PROMPT } from "./review.js";

function clone(value) {
  return structuredClone(value);
}

export class AppStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.configurations = [];
    this.conversations = [];
    this.ephemeralConversations = new Map();
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents);

      if (Array.isArray(parsed)) {
        // Preserve chat data written by versions before prompt configurations existed.
        this.configurations = [];
        this.conversations = parsed.map((conversation) => ({
          ...conversation,
          configurationId: conversation.configurationId ?? null,
          saveChats: true,
        }));
        await this.persist();
        return;
      }

      if (!parsed || !Array.isArray(parsed.configurations) || !Array.isArray(parsed.conversations)) {
        throw new Error("The app data file has an invalid format.");
      }

      this.configurations = parsed.configurations.map((configuration) => ({
        ...configuration,
        evaluationPrompt: !configuration.evaluationPrompt || configuration.evaluationPrompt === LEGACY_EVALUATION_PROMPT
          ? DEFAULT_EVALUATION_PROMPT : configuration.evaluationPrompt,
      }));
      this.conversations = parsed.conversations;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  listConfigurations() {
    return clone(
      this.configurations
        .map((configuration) => {
          const savedChats = this.conversations.filter(
            (conversation) => conversation.configurationId === configuration.id,
          );
          const latestChat = savedChats.reduce(
            (latest, conversation) => !latest || conversation.updatedAt > latest
              ? conversation.updatedAt
              : latest,
            null,
          );
          return {
            ...configuration,
            savedConversationCount: savedChats.length,
            latestConversationAt: latestChat,
          };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  getConfiguration(id) {
    const configuration = this.configurations.find((item) => item.id === id);
    return configuration ? clone(configuration) : null;
  }

  async createConfiguration({ name, prompt, saveChats, category, evaluationPrompt = DEFAULT_EVALUATION_PROMPT }) {
    const now = new Date().toISOString();
    const configuration = {
      id: randomUUID(),
      name,
      prompt,
      evaluationPrompt,
      saveChats,
      category,
      createdAt: now,
      updatedAt: now,
    };
    this.configurations.push(configuration);
    await this.persist();
    return clone(configuration);
  }

  async updateConfiguration(id, { name, prompt, saveChats, category, evaluationPrompt }) {
    const configuration = this.configurations.find((item) => item.id === id);
    if (!configuration) return null;

    configuration.name = name;
    configuration.prompt = prompt;
    configuration.evaluationPrompt = evaluationPrompt ?? configuration.evaluationPrompt ?? DEFAULT_EVALUATION_PROMPT;
    configuration.saveChats = saveChats;
    configuration.category = category;
    configuration.updatedAt = new Date().toISOString();
    await this.persist();
    return clone(configuration);
  }

  async deleteConfiguration(id) {
    const index = this.configurations.findIndex((item) => item.id === id);
    if (index === -1) return false;

    this.configurations.splice(index, 1);
    this.conversations = this.conversations.filter(
      (conversation) => conversation.configurationId !== id,
    );
    for (const [conversationId, conversation] of this.ephemeralConversations) {
      if (conversation.configurationId === id) this.ephemeralConversations.delete(conversationId);
    }
    await this.persist();
    return true;
  }

  listConversations(configurationId) {
    return clone(
      this.conversations
        .filter((conversation) => conversation.configurationId === configurationId)
        .map(({ messages, ...conversation }) => ({
          ...conversation,
          messageCount: messages.length,
          preview: messages.at(-1)?.content ?? "",
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  getConversation(id) {
    const conversation = this.conversations.find((item) => item.id === id)
      ?? this.ephemeralConversations.get(id);
    return conversation ? withQuestions(clone(conversation)) : null;
  }

  async createConversation(configurationId, userContent, assistantContent) {
    const configuration = this.configurations.find((item) => item.id === configurationId);
    if (!configuration) return null;

    const now = new Date().toISOString();
    const conversation = {
      id: randomUUID(),
      configurationId,
      title: configuration.name,
      saveChats: configuration.saveChats,
      createdAt: now,
      updatedAt: now,
      messages: [
        { id: randomUUID(), role: "user", content: userContent, createdAt: now },
        { id: randomUUID(), role: "assistant", content: assistantContent, createdAt: now },
      ],
    };

    if (conversation.saveChats) {
      this.conversations.push(conversation);
      await this.persist();
    } else {
      this.ephemeralConversations.set(conversation.id, conversation);
    }
    return withQuestions(clone(conversation));
  }

  async deleteConversation(id) {
    const index = this.conversations.findIndex((item) => item.id === id);
    if (index !== -1) {
      this.conversations.splice(index, 1);
      await this.persist();
      return true;
    }
    return this.ephemeralConversations.delete(id);
  }

  async appendExchange(id, userContent, assistantContent, metadata = {}) {
    const conversation = this.conversations.find((item) => item.id === id)
      ?? this.ephemeralConversations.get(id);
    if (!conversation) return null;

    const userMessage = {
      id: randomUUID(),
      role: "user",
      content: userContent,
      ...metadata,
      createdAt: new Date().toISOString(),
    };
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant",
      content: assistantContent,
      ...(metadata.kind ? { kind: metadata.kind } : {}),
      createdAt: new Date().toISOString(),
    };

    conversation.messages.push(userMessage, assistantMessage);
    conversation.updatedAt = assistantMessage.createdAt;
    if (conversation.saveChats) await this.persist();
    return clone({ conversation: withQuestions(conversation), userMessage, assistantMessage });
  }

  persist() {
    const snapshot = JSON.stringify({
      version: 4,
      configurations: this.configurations,
      conversations: this.conversations,
    }, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;

    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(temporaryPath, `${snapshot}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}

export const ConversationStore = AppStore;
