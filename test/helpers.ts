import { loadConfig, type Config } from "../src/core/config.js";

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { JIRA_BASE_URL: "https://jira.example.com", JIRA_AUTH_METHOD: "pat", JIRA_PAT: "pat-secret-value", ...overrides };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(testEnv(overrides));
}
