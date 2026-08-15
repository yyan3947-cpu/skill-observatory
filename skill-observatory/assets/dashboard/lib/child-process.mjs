import { spawn } from "node:child_process";

export function sanitizeChildEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.GITHUB_TOKEN;
  return sanitized;
}

export function spawnSanitized(
  command,
  args = [],
  options = {},
  { environment = process.env, spawnImpl = spawn } = {},
) {
  return spawnImpl(command, args, {
    ...options,
    env: sanitizeChildEnvironment(options.env ?? environment),
  });
}
