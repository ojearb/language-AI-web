# Local AI Prompt Library

A local-first prompt library for launching repeatable AI practice sessions. Each card stores a name, an optional category, a starting prompt, and a chat-history preference. Cards in the same category are grouped under a shared title, so templates for a class, book, or project stay together. Opening a card always starts a fresh chat and sends its prompt automatically. AI replies are provided by [OpenRouter](https://openrouter.ai/).

## Run it

1. Open [`.env`](./.env) and set your OpenRouter API key and preferred model:

   ```dotenv
   OPENROUTER_API_KEY=your_key_here
   OPENROUTER_MODEL=openai/gpt-4o-mini
   ```

2. Build and start the app:

   ```sh
   docker compose up --build
   ```

3. Open <http://localhost:3000>.

The port is bound to `127.0.0.1`, so the web interface is only reachable from this computer. Templates, categories, and saved chats are stored in `server/data/conversations.json`. Docker mounts this project folder directly, so Docker and a local Node server use the same data file. The file remains available after containers stop, Docker shuts down, or the computer restarts, and is included when you add and commit the project to Git.

Each configuration has a **Save chat history** setting:

- Off: the configuration remains permanent, but launched chats only live in server memory and disappear when the server or Docker stops.
- On: launched chats are written to the Docker volume and can be reopened from the configuration's settings.

To stop the app, press `Ctrl+C`. To stop it later from another terminal, run `docker compose down`. Your data stays in the project folder.

## Transfer data with Git

After changing templates or using saved chats, stop the app and commit `server/data/conversations.json` with your code, then push. On the other computer, stop the app before pulling, then start it again with `docker compose up --build`. The app loads the templates, categories, and saved chats from the pulled data file. Git transfers data when you commit, push, and pull; it does not sync automatically while the app is running. Commit and transfer changes from one computer before editing data on another to avoid conflicting versions of the file.

The data file includes prompt text and saved conversation contents. Chats with **Save chat history** turned off, unsubmitted answers, recordings, and browser-specific microphone/transcript preferences are not stored in this file. `.env` stays excluded from Git; copy your API key settings separately to the other computer.

### Existing Docker volume

Older versions stored data in the Docker volume `language-ai-web_conversation_data`. Before starting the updated app for the first time, stop the old server and copy its data into the project folder:

```sh
docker compose stop server
docker compose cp server:/app/data/conversations.json ./server/data/conversations.json
```

These commands use the existing container, so run them before recreating or removing it. If the old container has already been removed, use a temporary container to copy from the old volume instead (this requires the previous server image to still be installed):

```sh
docker create --name prompt-data-transfer --mount type=volume,src=language-ai-web_conversation_data,dst=/legacy,readonly language-ai-web-server:latest
docker cp prompt-data-transfer:/legacy/conversations.json ./server/data/conversations.json
docker rm prompt-data-transfer
```

Check the copied file contains your templates before running `docker compose up --build`. The old volume remains available as a backup. If you previously ran Node directly, your data is already in the correct folder.

## Configuration

Templates include an **Answer evaluation prompt** alongside the starting prompt. Use it to set the grading criteria, feedback language, strictness, or examples the AI should provide. Existing templates using the previous stock rubric receive the improved default; custom rubrics are preserved. Reviews use the original session prompt and follow-up context that preceded the selected question, even after a template is edited. They assess meaning and relevant target grammar separately, accept valid alternatives, and do not require every grammar point from a whole set in each answer. Feedback renders Markdown in both Practice and Conversation, including saved feedback.

## Voice answers

1. Find a topic in the library and click **Start practicing**. Click the text of the question you want to answer; that first click selects it and opens its voice-answer area. You can also click question text in **Conversation**. Each exercise appears separately, including unnumbered translation sentences and clock times. A location with its start and end times stays together as one exercise.
2. Tap the large microphone button, or press **Space**, and speak. The default microphone connects automatically. The input meter shows microphone activity.
3. Tap the button again to **Finish answer**. Transcription and feedback happen automatically. There is no separate transcription or submission step. Recordings stop after five minutes; **Cancel** discards the recording without sending it.
4. Read the feedback and click **Next exercise**. Choose any exercise by clicking its text in the question list, including on a phone. **Close** hides the voice answer and returns to the list without discarding drafts.

Use **Type instead** to write an answer. After feedback, **Edit answer** lets you correct the transcript and request another review. The home page?s app-wide **Settings** tab contains the microphone selector, microphone permission and device-refresh controls, and **Check the transcript before feedback**. These preferences are remembered on this browser and apply to all topics and conversations. Sessions contain only **Practice** and **Conversation** tabs. No microphone settings appear in the voice-answer area. Playback is under **Your answer** in the feedback, or **Listen to recording** after an error.

Each exercise keeps its own draft and recording while you switch exercises or open **Conversation**. Unsubmitted drafts and audio stay in browser memory and are cleared when you leave or reload the session. Submitted answers and feedback follow the template's chat-history setting. Exercise switching is disabled during recording, transcription, and review to keep the answer attached to the right exercise. Existing saved reviews remain associated with their original exercise; an old combined review is retained in Conversation and is not treated as a review of a newly separated item.

Transcription uses [`openai/gpt-transcribe`](https://openrouter.ai/openai/gpt-transcribe) through OpenRouter's [`/audio/transcriptions` API](https://openrouter.ai/docs/guides/overview/multimodal/stt). Evaluation uses your existing `OPENROUTER_MODEL` and API key. Audio is sent when a recording stops or you retry transcription and is not saved to the app's data file. Transcripts and feedback follow the template's **Save chat history** setting. The microphone is released when you stop recording, disconnect, or leave the session.

Microphone access requires localhost or HTTPS and a browser supporting `MediaRecorder` (current Chrome, Edge, Firefox, or Safari). For other devices or browsers, allow microphone access in the site's browser settings. Individual audio uploads are limited to 25 MB.

## Checks

Run `npm test` in `server` for the API and persistence tests. In `client`, run `npm run build`, then `npm run test:browser` for the recording and review flow. The browser checks use a simulated microphone, temporary storage, and a mock OpenRouter server, so they do not use your API key. Install a test browser with `npx playwright install chromium`, or set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome. Browser screenshots are written to `client/test-results`.

## Model settings

- `OPENROUTER_API_KEY`: your OpenRouter API key.
- `OPENROUTER_MODEL`: an OpenRouter model slug.

The API key is read by the local Node server and is not embedded in the browser bundle.

## Launch Codex

From the project folder, run:

```powershell
codex
```

The project configuration in `.codex/config.toml` starts new Codex sessions in
YOLO mode: `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`.
Codex can write files and run commands without approval prompts or sandboxing.
The startup permissions indicator should show `YOLO mode`.

Codex loads project configuration for trusted folders. This folder is already
trusted on this computer; on another computer, trust it when prompted. Restart
an existing Codex session to use these settings.
