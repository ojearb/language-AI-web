import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { AppStore } from "../src/store.js";

test("prompt configurations launch fresh chats and persist only when enabled", async (context) => {
  const testDirectory = await mkdtemp(path.join(tmpdir(), "language-ai-web-"));
  context.after(() => rm(testDirectory, { recursive: true, force: true }));
  const dataFile = path.join(testDirectory, "app-data.json");
  const modelRequests = [];

  const openRouter = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    modelRequests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `Mock reply ${modelRequests.length}` } }],
    }));
  });
  await listen(openRouter);
  context.after(() => close(openRouter));

  const store = new AppStore(dataFile);
  await store.initialize();
  const app = createApp({
    store,
    openRouterConfig: {
      apiKey: "test-key",
      model: "test/model",
      baseUrl: `http://127.0.0.1:${openRouter.address().port}`,
    },
  });
  const apiServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
  context.after(() => close(apiServer));
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;

  const savedConfig = await jsonRequest(`${apiUrl}/api/configurations`, {
    method: "POST",
    body: JSON.stringify({
      name: "Integer practice",
      category: "Evening classes",
      prompt: "Give me a new integer problem.",
      saveChats: true,
    }),
  });
  assert.equal(savedConfig.response.status, 201);
  assert.equal(savedConfig.body.configuration.name, "Integer practice");
  assert.equal(savedConfig.body.configuration.category, "Evening classes");

  const startedSaved = await jsonRequest(
    `${apiUrl}/api/configurations/${savedConfig.body.configuration.id}/start`,
    { method: "POST" },
  );
  assert.equal(startedSaved.response.status, 201);
  assert.equal(startedSaved.body.conversation.saveChats, true);
  assert.deepEqual(
    startedSaved.body.conversation.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Give me a new integer problem." },
      { role: "assistant", content: "Mock reply 1" },
    ],
  );
  assert.match(modelRequests[0].messages[0].content, /each independently answerable exercise in a separate paragraph/);
  assert.deepEqual(modelRequests[0].messages.at(-1), { role: "user", content: "Give me a new integer problem." });

  const continued = await jsonRequest(
    `${apiUrl}/api/conversations/${startedSaved.body.conversation.id}/messages`,
    { method: "POST", body: JSON.stringify({ content: "My answer is -7." }) },
  );
  assert.equal(continued.body.conversation.messages.length, 4);
  assert.equal(modelRequests[1].messages.at(-1).content, "My answer is -7.");

  const savedHistory = await jsonRequest(
    `${apiUrl}/api/configurations/${savedConfig.body.configuration.id}/conversations`,
  );
  assert.equal(savedHistory.body.conversations.length, 1);
  assert.equal(savedHistory.body.conversations[0].messageCount, 4);

  const temporaryConfig = await jsonRequest(`${apiUrl}/api/configurations`, {
    method: "POST",
    body: JSON.stringify({
      name: "Fresh vocabulary",
      category: "Language study",
      prompt: "Quiz me on one new word.",
      saveChats: false,
    }),
  });
  const startedTemporary = await jsonRequest(
    `${apiUrl}/api/configurations/${temporaryConfig.body.configuration.id}/start`,
    { method: "POST" },
  );
  assert.equal(startedTemporary.body.conversation.saveChats, false);
  assert.equal(store.getConversation(startedTemporary.body.conversation.id).messages.length, 2);

  const restartedStore = new AppStore(dataFile);
  await restartedStore.initialize();
  assert.equal(restartedStore.listConfigurations().length, 2);
  assert.ok(restartedStore.getConversation(startedSaved.body.conversation.id));
  assert.equal(restartedStore.getConversation(startedTemporary.body.conversation.id), null);
  assert.deepEqual(restartedStore.listConversations(temporaryConfig.body.configuration.id), []);

  const updated = await jsonRequest(
    `${apiUrl}/api/configurations/${temporaryConfig.body.configuration.id}`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: "Vocabulary drill",
        category: "Evening classes",
        prompt: "Quiz me on two new words.",
        saveChats: false,
      }),
    },
  );
  assert.equal(updated.body.configuration.name, "Vocabulary drill");
  assert.equal(updated.body.configuration.category, "Evening classes");

  const deleted = await fetch(
    `${apiUrl}/api/configurations/${savedConfig.body.configuration.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 204);
  assert.equal(store.getConversation(startedSaved.body.conversation.id), null);
});

test("configuration API validates required settings", async (context) => {
  const testDirectory = await mkdtemp(path.join(tmpdir(), "language-ai-web-validation-"));
  context.after(() => rm(testDirectory, { recursive: true, force: true }));
  const store = new AppStore(path.join(testDirectory, "app-data.json"));
  await store.initialize();
  const apiServer = createApp({ store, openRouterConfig: {} }).listen(0, "127.0.0.1");
  await new Promise((resolve) => apiServer.once("listening", resolve));
  context.after(() => close(apiServer));
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;

  const missingName = await jsonRequest(`${apiUrl}/api/configurations`, {
    method: "POST",
    body: JSON.stringify({ name: "", prompt: "A prompt", saveChats: false }),
  });
  assert.equal(missingName.response.status, 400);
  assert.match(missingName.body.error, /Name/);

  const invalidSetting = await jsonRequest(`${apiUrl}/api/configurations`, {
    method: "POST",
    body: JSON.stringify({ name: "Practice", prompt: "A prompt", saveChats: "no" }),
  });
  assert.equal(invalidSetting.response.status, 400);
  assert.match(invalidSetting.body.error, /true or false/);
});

async function jsonRequest(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return { response, body: await response.json() };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
