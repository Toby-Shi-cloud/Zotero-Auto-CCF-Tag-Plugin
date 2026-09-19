import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import type { AcademicCandidate, ItemSnapshot } from "./aiTypes";

const KEY_ORIGIN = `chrome://${config.addonRef}`;
const KEY_REALM = "OpenAI-compatible API key";

function keyLogin() {
  return Services.logins.findLogins(KEY_ORIGIN, null as any, KEY_REALM)[0];
}

export function getAPIKey(): string {
  return keyLogin()?.password || "";
}

export async function setAPIKey(value: string) {
  const oldLogin = keyLogin();
  if (oldLogin) Services.logins.removeLogin(oldLogin);
  if (!value) return;
  const login = Components.classes[
    "@mozilla.org/login-manager/loginInfo;1"
  ].createInstance(Components.interfaces.nsILoginInfo);
  login.init(KEY_ORIGIN, null, KEY_REALM, config.addonID, value, "", "");
  await Services.logins.addLogins([login]);
}

function baseURL() {
  const configured = (
    getPref("aiBaseURL") || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  return /\/v1$/i.test(configured) ? configured : `${configured}/v1`;
}

export async function listModels(): Promise<string[]> {
  const response = await Zotero.HTTP.request("GET", `${baseURL()}/models`, {
    headers: { Authorization: `Bearer ${getAPIKey()}` },
    timeout: 15000,
  });
  const parsed = JSON.parse(response.responseText || "{}") as {
    data?: Array<{ id: string }>;
  };
  return (parsed.data || []).map((model) => model.id).sort();
}

export async function checkAIConnection() {
  await complete([{ role: "user", content: "Reply with OK." }]);
}

export async function inspectWithAI(
  snapshot: ItemSnapshot,
  candidates: AcademicCandidate[],
) {
  const text = await complete([
    {
      role: "system",
      content:
        "You are a scholarly metadata verifier. Return strict JSON only: {queries:string[], matchedCandidate:number|null, samePaper:boolean, venue:string|null, formalVersionCandidate:number|null, explanation:string}. Never invent metadata; candidates are the only external evidence.",
    },
    { role: "user", content: JSON.stringify({ item: snapshot, candidates }) },
  ]);
  try {
    const result = JSON.parse(text) as Record<string, unknown>;
    return {
      queries: Array.isArray(result.queries)
        ? result.queries
            .filter((x): x is string => typeof x === "string")
            .slice(0, 2)
        : [],
      matchedCandidate:
        typeof result.matchedCandidate === "number"
          ? result.matchedCandidate
          : null,
      samePaper: result.samePaper === true,
      venue: typeof result.venue === "string" ? result.venue : null,
      formalVersionCandidate:
        typeof result.formalVersionCandidate === "number"
          ? result.formalVersionCandidate
          : null,
      explanation:
        typeof result.explanation === "string"
          ? result.explanation
          : "AI returned no explanation",
    };
  } catch {
    throw new Error("AI returned invalid JSON; no changes were applied.");
  }
}

async function complete(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const key = getAPIKey();
  const model = getPref("aiModel");
  if (!key || !model) throw new Error("AI API key and model are required.");
  const effort = getPref("aiReasoningEffort");
  const body: Record<string, unknown> = { model, messages, temperature: 0 };
  if (effort) body.reasoning_effort = effort;
  const response = await Zotero.HTTP.request(
    "POST",
    `${baseURL()}/chat/completions`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      timeout: 60000,
      logBodyLength: 0,
    },
  );
  const parsed = JSON.parse(response.responseText || "{}") as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned no message content.");
  return content.replace(/^```json\s*|\s*```$/g, "");
}
