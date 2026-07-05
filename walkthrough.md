# Walkthrough — Unified Backend AI Invocations

We have successfully migrated all client-side AI invocations (conversational chat, diagnosis, and summarization) to the secure backend Cloudflare Worker, eliminating the client-side API key vulnerability.

---

## 1. Backend Updates (`src/worker.js`)
- **Optional Authentication on `/api/diagnose`**: Refactored the route to authenticate optionally. Guest users can now make requests by supplying car parameters in the body, while signed-in users automatically benefit from saved garage D1 records.
- **Added `/api/ai/chat` Route**:
  - Implemented the `POST /api/ai/chat` route to support the frontend's new auth-gated conversational flow.
  - This route accepts `{ contents, system, search, temp }` and proxies it to Gemini using the secure backend API key.
- **Unified Route Modes**:
  - `mode: "diagnose"` (Default): Performs structured **Gemma 4 31B-it** car diagnosis.
  - `mode: "chat"`: Handles open-ended multi-turn conversational chat with Gemini. Passes inline base64 image, video, and audio buffers securely.
  - `mode: "summarize"`: Summarizes conversation logs into a clean JSON object for the diagnosis summary card.
- **Wrangler dry-run compile validation**: Succeeded with total upload size `78.03 KiB`.

---

## 2. Configuration & Smart Placement (`wrangler.jsonc`)
- **Model Upgrade**: Switched the diagnostic model variable `GEMMA_MODEL` to `"gemma-4-31b-it"`.
- **Smart Placement**: Enabled placement routing mode (`smart`) to run Worker executions close to the D1 database, resolving Google's regional egress IP block.
- **Configurable Base URL**: Defined `GEMINI_BASE_URL` in project variables to allow easy proxying if required in the future.

---

## 3. Frontend Updates (`chat.html` & `index.html`)
- **Key Removal**: Set `GEMINI_KEY = ""` in both files, preventing direct browser requests to Google API.
- **Backend API Routing**:
  - Implemented the `callBackendAI(body)` function in `chat.html` to communicate with `/api/diagnose`.
  - Redirected `sendMsg()` to call backend with `{ mode: "chat", messages: messages }`.
  - Redirected `makeSummary()` to call backend with `{ mode: "summarize", messages: messages }`.
