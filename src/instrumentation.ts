// Runs once when the Next.js server starts, before it serves requests.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("./lib/startup/checks");
  await runStartupChecks("web");
}
