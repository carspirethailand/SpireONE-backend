# Walkthrough — ReAct Agentic Chat System (v4)

We have successfully restored the main conversation system of SpireONE to a unified **ReAct Agentic Loop** and resolved the backend database execution issues.

---

## 1. Database Schema Fix
- **Created Migration `0003_add_admin_system.sql`**:
  - Adds `created_at` and `banned` columns to the `users` table, which were causing SQL errors during login.
  - Creates the `config`, `audit`, and `usage` tables used for system maintenance and quota limits.
  - Successfully tested and applied local migrations (`--local`).

---

## 2. Backend Updates (`src/worker.js`)
- **Restored `runReActAgent(env, carInfo, messages)`**:
  - Orchestrates a 3-step ReAct (Reasoning + Action) loop.
  - Matches regex `Action: <toolName>(<param>)` from reasoning model completions and executes them.
- **Dynamic Reasoning Provider (`callReasoningModel`)**:
  - Automatically resolves which API provider to use based on the environment variables defined in wrangler secrets:
    1. **Cerebras** (`gpt-oss-120b`) if `CEREBRAS_API_KEY` is present.
    2. **Groq** (`llama-3.3-70b-versatile`) if `GROQ_API_KEY` is present.
    3. **OpenRouter** (`meta-llama/llama-3.3-70b-instruct`) if `OPENROUTER_API_KEY` is present.
- **WAF Bypass Headers & Auto-Retry Mechanism (`fetchWithRetry`)**:
  - Handles Cloudflare WAF challenges by automatically retrying with random delay and client-spoofed browser headers.
- **Implemented `executeDescribeMediaTool`**:
  - Exposes Gemini 3.5 Flash as a tool. Analyzes base64 attachments in the chat history.
- **Implemented `executeGoogleSearchTool`**:
  - Exposes Gemini 3.5 Flash as a tool. Runs search queries using Gemini's search grounding.
- **Integrated in `/api/ai/chat` Endpoint**:
  - Extracts the `carId` context from the request payload, queries D1 for vehicle specifications, and feeds it to `runReActAgent`.

---

## 3. Frontend Updates (`chat.html`)
- **Car Context Payload**: Modified the `gemini` function in `chat.html` to inject `carId` into the `/api/ai/chat` POST body, ensuring the backend agent has access to vehicle specs.
