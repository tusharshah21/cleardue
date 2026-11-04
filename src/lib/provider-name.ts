/** The name shown to users for a provider label like "openai/gpt-5.4-mini": "OpenAI gpt-5.4-mini". */
export function providerName(label: string): string {
  const [provider, ...model] = label.split("/");
  return `${{ google: "Gemini", openai: "OpenAI", anthropic: "Claude" }[provider] ?? provider} ${model.join("/")}`.trim();
}
