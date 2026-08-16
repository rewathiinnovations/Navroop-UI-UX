import { looksLikeUrl } from "@/lib/projects/prompt";
import type { StackId } from "@/lib/stacks";

export function armProjectGeneration(prompt: string) {
  if (typeof window === "undefined") return;
  if (looksLikeUrl(prompt)) {
    sessionStorage.setItem("targetUrl", prompt);
    sessionStorage.setItem("autoStart", "true");
    return;
  }
  sessionStorage.setItem("navroopPrompt", prompt);
}

export async function createProjectFromPrompt(prompt: string, stack: StackId) {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, status: "idle", stack }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      error: String(data.error || "Could not create project"),
    };
  }
  armProjectGeneration(prompt);
  return { ok: true as const, project: data.project as { id: string } };
}
