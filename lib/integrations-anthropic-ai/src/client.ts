import Anthropic from "@anthropic-ai/sdk";

/**
 * Keeper-only stack: no Anthropic env required at startup.
 * If keys are missing, `anthropic` is a stub that throws only if code calls the API.
 */
const hasAnthropicEnv =
  Boolean(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) &&
  Boolean(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY);

export const anthropic: Anthropic = hasAnthropicEnv
  ? new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL!,
    })
  : (new Proxy({} as object, {
      get(_t, prop: string | symbol) {
        if (prop === "messages") {
          return {
            create: async () => {
              throw new Error(
                "Anthropic is disabled: keeper-only stack (set AI_INTEGRATIONS_* only if you intentionally enable LLM calls).",
              );
            },
          };
        }
        return undefined;
      },
    }) as Anthropic);
