import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import type { AcademicCandidate, ItemSnapshot } from "./aiTypes";

const KEY_ORIGIN = `chrome://${config.addonRef}`;
export type AIProvider = "openai" | "google" | "anthropic" | "custom";

function provider(): AIProvider {
  const value = getPref("aiProvider");
  return value === "google" || value === "anthropic" || value === "custom"
    ? value
    : "openai";
}

function keyRealm(name: AIProvider) {
  return name === "openai" ? "OpenAI-compatible API key" : `${name} API key`;
}

function keyLogin(name: AIProvider) {
  return Services.logins.findLogins(KEY_ORIGIN, null as any, keyRealm(name))[0];
}

export function getAPIKey(name: AIProvider = provider()): string {
  return keyLogin(name)?.password || "";
}

export async function setAPIKey(value: string, name: AIProvider = provider()) {
  const oldLogin = keyLogin(name);
  if (oldLogin) Services.logins.removeLogin(oldLogin);
  if (!value) return;
  const login = Components.classes[
    "@mozilla.org/login-manager/loginInfo;1"
  ].createInstance(Components.interfaces.nsILoginInfo);
  login.init(KEY_ORIGIN, null, keyRealm(name), config.addonID, value, "", "");
  await Services.logins.addLogins([login]);
}

function baseURL() {
  const current = provider();
  if (current === "google")
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  if (current === "anthropic") return "https://api.anthropic.com/v1";
  if (current === "openai") return "https://api.openai.com/v1";
  const configured = (getPref("aiBaseURL") || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(configured))
    throw new Error("自定义服务地址必须以 https:// 开头。");
  return /\/v1$/i.test(configured) ? configured : `${configured}/v1`;
}

export async function listModels(): Promise<string[]> {
  const response = await Zotero.HTTP.request("GET", `${baseURL()}/models`, {
    headers:
      provider() === "anthropic"
        ? { "x-api-key": getAPIKey(), "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${getAPIKey()}` },
    // Some compatible gateways cold-start the model catalogue. Keep this in
    // line with completion requests so a working service is not reported as
    // unavailable after only 15 seconds.
    timeout: 60000,
  });
  const parsed = JSON.parse(response.responseText || "{}") as {
    data?: Array<{ id: string }>;
  };
  if (!Array.isArray(parsed.data))
    throw new Error("模型接口没有返回 data 列表，请检查 Base URL 和 API Key。");
  return parsed.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && !!id)
    .sort();
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
  if (provider() === "anthropic") {
    const system = messages.find(
      (message) => message.role === "system",
    )?.content;
    const response = await Zotero.HTTP.request(
      "POST",
      `${baseURL()}/messages`,
      {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          ...(system ? { system } : {}),
          messages: messages.filter((message) => message.role !== "system"),
        }),
        timeout: 60000,
        logBodyLength: 0,
      },
    );
    const parsed = JSON.parse(response.responseText || "{}") as {
      content?: Array<{ type: string; text?: string }>;
    };
    const content = parsed.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
    if (!content) throw new Error("AI 未返回文本内容。");
    return content.replace(/^```json\s*|\s*```$/g, "");
  }
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
