# Walkthrough — ReAct Agentic Chat System (v3)

We have successfully migrated the main conversation system of SpireONE to a unified **ReAct Agentic Loop** using **Cerebras `gpt-oss-120b`** as the controller and **Google Gemini 2.5 Flash** as tool executors.

---

## 1. Backend Updates (`src/worker.js`)
- **Implemented `runReActAgent(env, carInfo, messages)`**:
  - The primary conversation handler. Orchestrates a 3-step ReAct (Reasoning + Action) loop.
  - Matches regex `Action: <toolName>(<param>)` from `gpt-oss-120b` responses and executes them, appending outcomes as `Observation: <result>` to the reasoning context before looping.
- **WAF Bypass Headers**:
  - Added standard browser `User-Agent` and `Accept` headers to outbound Cerebras fetch requests in `getCerebrasDiagnosis` and `runReActAgent`. This prevents Cloudflare's WAF on Cerebras's side from challenging and blocking our Worker requests.
- **Implemented `executeDescribeMediaTool`**:
  - Exposes Gemini 2.5 Flash as a tool. Retrieves all `inline_data` attachments (base64 image, video, or audio) in the message history, analyzes them according to the agent's prompt, and returns the observation back to the loop.
- **Implemented `executeGoogleSearchTool`**:
  - Exposes Gemini 2.5 Flash as a tool. Takes a search query, uses Gemini's search grounding capability, and returns the summarized web findings back to the loop.
- **Unified `/api/ai/chat` Endpoint**:
  - Replaced the direct Gemini proxy route. It now queries car specs from the D1 database using `carId` (if logged in) and executes `runReActAgent`.
- **Wrangler dry-run compile validation**: Succeeded with total upload size `86.87 KiB`.

---

## 2. Frontend Updates (`chat.html`)
- **Dynamic Context Injection**: Updated the `gemini` chat runner in `chat.html` to fetch the selected car (`selCar()`) and pass `carId` inside the `/api/ai/chat` body, giving the ReAct agent full vehicle specification context.
- **Unified Diagnostic Flow**: Chat messages are now processed entirely through the unified `/api/ai/chat` endpoint, using the conversational diagnostic loop.

---

## 3. Configuration & Smart Placement (`wrangler.jsonc`)
- **New Environment Variables**:
  - `"CEREBRAS_MODEL": "gpt-oss-120b"`
  - `"CEREBRAS_BASE_URL": "https://api.cerebras.ai/v1"`
