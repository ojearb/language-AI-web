import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { AppStore } from '../src/store.js';
import { extractQuestions, withQuestions } from '../src/questions.js';
import { DEFAULT_EVALUATION_PROMPT, LEGACY_EVALUATION_PROMPT } from '../src/review.js';
import { TRANSCRIPTION_MODEL } from '../src/openrouter.js';

const generated = 'Here are two questions:\n\n1. What is 2 + 2?\n2. What is 3 + 4?';

test('splits translation statements without requiring question marks or numbering', () => {
  const sentences = ['This is my book.', 'That bag is Maria’s.', 'Mr. Tanaka is a teacher.', 'I do not read books on Sunday.', 'She also works at the bank.'];
  for (const content of [sentences.join('\n'), sentences.join('\n\n'), sentences.map((s) => `- ${s}`).join('\n')]) {
    assert.deepEqual(extractQuestions(content, { prompt: 'Write 5 simple English sentences for Japanese translation practice.' }), sentences);
  }
  assert.deepEqual(extractQuestions('This is my book. That is your bag.', { prompt: 'Write 5 English sentences for Japanese translation practice.' }), ['This is my book.', 'That is your bag.']);
  assert.deepEqual(extractQuestions('1. This is my book. 2. That is your bag.'), ['This is my book.', 'That is your bag.']);
});

test('splits clock lists and keeps locations and time pairs in one exercise', () => {
  const times = ['AM 7:15', 'PM 3:40', 'AM 11:08', 'PM 6:22', 'AM 9:56'];
  assert.deepEqual(extractQuestions(times.join('\n'), { prompt: 'Write a list with times.' }), times);
  const pairs = ['Library\nAM 9:00\nPM 1:30', 'School\nAM 8:15\nPM 3:00'];
  assert.deepEqual(extractQuestions(pairs.join('\n')), pairs);
  assert.deepEqual(extractQuestions(pairs.join('\n\n')), pairs);
  assert.deepEqual(extractQuestions('AM 9:00\nPM 1:30\nAM 8:15\nPM 3:00', { prompt: 'Write a list with time pairs.' }), ['AM 9:00\nPM 1:30', 'AM 8:15\nPM 3:00']);
});

test('does not attach a previous combined review to a newly split first exercise', () => {
  const content = 'This is my book.\nThat is your bag.';
  const conversation = { messages: [
    { id: 'prompt', role: 'user', content: 'Write 5 sentences for translation practice.' },
    { id: 'generated', role: 'assistant', content },
    { role: 'user', kind: 'answer-review', questionId: 'generated:0', question: content, answer: 'Old combined answer' },
  ] };
  const result = withQuestions(conversation);
  assert.equal(result.questions.length, 2);
  assert.notEqual(result.questions[0].id, 'generated:0');
  conversation.messages[2].question = 'This is my book.';
  assert.equal(withQuestions(conversation).questions[0].id, 'generated:0');
});

test('selects individual questions from common generated formats', () => {
  assert.deepEqual(extractQuestions(generated), ['What is 2 + 2?', 'What is 3 + 4?']);
  assert.deepEqual(extractQuestions('### **Question 1:** Explain photosynthesis.\nInclude its inputs.\n\n### **Question 2:** Explain respiration.'),
    ['Explain photosynthesis.\nInclude its inputs.', 'Explain respiration.']);
  assert.deepEqual(extractQuestions('- What is a noun?\n- What is a verb?'), ['What is a noun?', 'What is a verb?']);
  assert.deepEqual(extractQuestions('What is a noun?\nWhat is a verb?'), ['What is a noun?', 'What is a verb?']);
  assert.deepEqual(extractQuestions('Translate this sentence: Bonjour.'), ['Translate this sentence: Bonjour.']);
  assert.deepEqual(extractQuestions('## Question 1\nWhat does this sentence mean?\n\nExplain your reasoning.\n\n## Question 2\nWhat is a noun?'),
    ['What does this sentence mean?\n\nExplain your reasoning.', 'What is a noun?']);
  assert.deepEqual(extractQuestions('1. Which word is a noun?\n    1. Dog\n    2. Run\n2. Which word is a verb?'),
    ['Which word is a noun?\n    1. Dog\n    2. Run', 'Which word is a verb?']);
});

test('transcribes audio with the dedicated OpenRouter model and supports browser-sized payloads', async (context) => {
  const fixture = await setup(context);
  const data = Buffer.alloc(900_000, 1).toString('base64');
  const result = await fixture.request(`/api/conversations/${fixture.conversation.id}/transcriptions`, {
    inputAudio: { data, format: 'webm' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.text, 'My answer is four.');
  assert.equal(result.body.model, TRANSCRIPTION_MODEL);
  assert.deepEqual(fixture.requests[0], {
    url: '/audio/transcriptions',
    authorization: 'Bearer test-key',
    body: { model: 'openai/gpt-transcribe', input_audio: { data, format: 'webm' }, response_format: 'json' },
  });
  assert.equal(fixture.store.getConversation(fixture.conversation.id).messages.length, 2);
  assert.equal((await readFile(fixture.dataFile, 'utf8')).includes(data), false);
});

test('reviews only the selected question using the custom rubric and persists feedback without audio', async (context) => {
  const fixture = await setup(context, { saveChats: true, evaluationPrompt: 'Grade strictly. Reply in Swedish.' });
  const chosen = fixture.conversation.questions[1];
  const result = await fixture.request(`/api/conversations/${fixture.conversation.id}/reviews`, {
    questionId: chosen.id, answer: '  Seven.  ',
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.feedback, 'Correct. The answer is seven.');
  const { messages, model } = fixture.requests[0].body;
  assert.equal(model, 'test/reviewer');
  assert.match(messages[0].content, /^Grade strictly\. Reply in Swedish\./);
  assert.deepEqual(JSON.parse(messages[1].content), {
    practiceInstructions: 'Generate two arithmetic questions.',
    generationContext: [],
    questionContext: generated,
    question: 'What is 3 + 4?',
    answer: 'Seven.',
  });
  assert.equal(result.body.conversation.messages.length, 4);
  assert.equal(result.body.conversation.messages[2].kind, 'answer-review');
  assert.equal(result.body.conversation.messages[2].answer, 'Seven.');
  assert.equal(result.body.conversation.messages[3].kind, 'answer-review');
  assert.deepEqual(result.body.conversation.questions, fixture.conversation.questions);
  const restarted = new AppStore(fixture.dataFile);
  await restarted.initialize();
  assert.equal(restarted.getConfiguration(fixture.configuration.id).evaluationPrompt, 'Grade strictly. Reply in Swedish.');
  assert.equal(restarted.getConversation(fixture.conversation.id).messages[3].content, result.body.feedback);
});

test('reviews retain the original prompt and only the context that preceded the selected exercise', async (context) => {
  const original = 'Create Japanese translation exercises using possessive no and negative verbs. Cover every pattern across the set. Output only English sentences.';
  const fixture = await setup(context, { prompt: original, saveChats: true });
  await fixture.store.appendExchange(fixture.conversation.id, 'Earlier answer', 'Earlier feedback', { kind: 'answer-review' });
  const followUp = 'Now practice past-tense negatives.';
  const generatedFollowUp = '1. I did not read her book yesterday.';
  const next = await fixture.store.appendExchange(fixture.conversation.id, followUp, generatedFollowUp);
  const selected = next.conversation.questions.at(-1);
  await fixture.store.appendExchange(fixture.conversation.id, 'Switch to French.', '1. Translate: Bonjour.');
  await fixture.store.updateConfiguration(fixture.configuration.id, { ...fixture.configuration, prompt: 'Practice French instead.' });
  const result = await fixture.request(`/api/conversations/${fixture.conversation.id}/reviews`, { questionId: selected.id, answer: 'Her book was not read yesterday.' });
  assert.equal(result.status, 201);
  const payload = JSON.parse(fixture.requests[0].body.messages[1].content);
  assert.equal(payload.practiceInstructions, original);
  assert.deepEqual(payload.generationContext, [
    { role: 'assistant', content: generated },
    { role: 'user', content: followUp },
  ]);
  assert.equal(payload.questionContext, generatedFollowUp);
  assert.equal(payload.question, 'I did not read her book yesterday.');
  await fixture.request(`/api/conversations/${fixture.conversation.id}/reviews`, { questionId: fixture.conversation.questions[0].id, answer: 'Four.' });
  assert.deepEqual(JSON.parse(fixture.requests[1].body.messages[1].content).generationContext, []);
});

test('only the previous stock rubric is upgraded; customized rubrics stay intact', async (context) => {
  const fixture = await setup(context, { evaluationPrompt: LEGACY_EVALUATION_PROMPT });
  const custom = await fixture.store.createConfiguration({ name: 'Custom', prompt: 'Practice', saveChats: false, evaluationPrompt: 'Reply in Swedish and use examples.' });
  const restarted = new AppStore(fixture.dataFile);
  await restarted.initialize();
  assert.equal(restarted.getConfiguration(fixture.configuration.id).evaluationPrompt, DEFAULT_EVALUATION_PROMPT);
  assert.equal(restarted.getConfiguration(custom.id).evaluationPrompt, custom.evaluationPrompt);
});

test('temporary reviews use the default rubric and stay out of persistent history', async (context) => {
  const fixture = await setup(context);
  const result = await fixture.request(`/api/conversations/${fixture.conversation.id}/reviews`, {
    questionId: fixture.conversation.questions[0].id, answer: 'Four.',
  });
  assert.equal(result.status, 201);
  assert.ok(fixture.requests[0].body.messages[0].content.startsWith(DEFAULT_EVALUATION_PROMPT));
  const persisted = JSON.parse(await readFile(fixture.dataFile, 'utf8'));
  assert.deepEqual(persisted.conversations, []);
  assert.equal(fixture.store.getConversation(fixture.conversation.id).messages.length, 4);
});

test('rejects invalid audio, oversized recordings, and answers to questions outside the conversation', async (context) => {
  const fixture = await setup(context);
  const transcriptionUrl = `/api/conversations/${fixture.conversation.id}/transcriptions`;
  for (const inputAudio of [{ data: '', format: 'webm' }, { data: 'data:audio/webm;base64,YQ==', format: 'webm' },
    { data: 'YQ==', format: 'video' }, { data: '????', format: 'wav' }]) {
    assert.equal((await fixture.request(transcriptionUrl, { inputAudio })).status, 400);
  }
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64');
  assert.equal((await fixture.request(transcriptionUrl, { inputAudio: { data: oversized, format: 'webm' } })).status, 413);
  const reviewUrl = `/api/conversations/${fixture.conversation.id}/reviews`;
  for (const body of [{ questionId: 'other-question', answer: 'Four.' },
    { questionId: fixture.conversation.questions[0].id, answer: ' ' },
    { questionId: fixture.conversation.questions[0].id, answer: 'x'.repeat(50_001) }]) {
    assert.equal((await fixture.request(reviewUrl, body)).status, 400);
  }
  assert.equal((await fixture.request('/api/conversations/missing/transcriptions', { inputAudio: { data: 'YQ==', format: 'wav' } })).status, 404);
  assert.equal((await fixture.request('/api/conversations/missing/reviews', { questionId: 'x', answer: 'Four.' })).status, 404);
  assert.equal(fixture.requests.length, 0);
});

test('provider errors and empty transcripts leave the conversation unchanged and allow retry', async (context) => {
  const fixture = await setup(context);
  const transcriptionUrl = `/api/conversations/${fixture.conversation.id}/transcriptions`;
  fixture.setReply({ text: '' });
  const empty = await fixture.request(transcriptionUrl, { inputAudio: { data: 'YQ==', format: 'wav' } });
  assert.equal(empty.status, 502);
  assert.match(empty.body.error, /No speech/);
  fixture.setReply({ error: { message: 'Rate limited' } }, 429);
  const rateLimited = await fixture.request(transcriptionUrl, { inputAudio: { data: 'YQ==', format: 'wav' } });
  assert.equal(rateLimited.status, 429);
  fixture.setReply({ error: { message: 'Provider unavailable' } });
  const reviewUrl = `/api/conversations/${fixture.conversation.id}/reviews`;
  const body = { questionId: fixture.conversation.questions[0].id, answer: 'Four.' };
  assert.equal((await fixture.request(reviewUrl, body)).status, 502);
  assert.equal(fixture.store.getConversation(fixture.conversation.id).messages.length, 2);
  fixture.setReply({ choices: [{ message: { content: 'Correct.' } }] });
  assert.equal((await fixture.request(reviewUrl, body)).status, 201);
});

test('legacy templates receive a rubric, and updates preserve it when older clients omit it', async (context) => {
  const fixture = await setup(context, { evaluationPrompt: 'Evaluate factual accuracy.' });
  const update = await fixture.request(`/api/configurations/${fixture.configuration.id}`, {
    name: 'Updated practice', category: '', prompt: 'A new prompt', saveChats: false,
  }, 'PUT');
  assert.equal(update.status, 200);
  assert.equal(update.body.configuration.evaluationPrompt, 'Evaluate factual accuracy.');
  const invalid = await fixture.request('/api/configurations', {
    name: 'Practice', prompt: 'A prompt', saveChats: false, evaluationPrompt: '',
  });
  assert.equal(invalid.status, 400);
  const legacy = JSON.parse(await readFile(fixture.dataFile, 'utf8'));
  delete legacy.configurations[0].evaluationPrompt;
  await writeFile(fixture.dataFile, JSON.stringify(legacy));
  const restarted = new AppStore(fixture.dataFile);
  await restarted.initialize();
  assert.equal(restarted.getConfiguration(fixture.configuration.id).evaluationPrompt, DEFAULT_EVALUATION_PROMPT);
});

async function setup(context, settings = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'language-ai-voice-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, 'data.json');
  const store = new AppStore(dataFile);
  await store.initialize();
  const configuration = await store.createConfiguration({
    name: 'Arithmetic', prompt: 'Generate two arithmetic questions.', category: '', saveChats: false, ...settings,
  });
  const conversation = await store.createConversation(configuration.id, configuration.prompt, generated);
  const requests = [];
  let reply;
  let status = 200;
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply ?? (request.url === '/audio/transcriptions'
      ? { text: 'My answer is four.' } : { choices: [{ message: { content: 'Correct. The answer is seven.' } }] })));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  context.after(() => shutdown(provider));
  const server = createApp({ store, openRouterConfig: {
    apiKey: 'test-key', model: 'test/reviewer', baseUrl: `http://127.0.0.1:${provider.address().port}`,
  } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => shutdown(server));
  return {
    store, configuration, conversation, requests, dataFile,
    setReply(body, httpStatus = 200) { reply = body; status = httpStatus; },
    async request(route, body, method = 'POST') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function shutdown(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
