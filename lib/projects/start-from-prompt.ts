import type { DesignDirectionId } from "@/lib/design/directions";
import { DEFAULT_IMPORT_MODE, type ImportMode } from "@/lib/import/mode";
import { looksLikeUrl } from "@/lib/projects/prompt";
import type { StackId } from "@/lib/stacks";

export function armProjectGeneration(prompt: string, importMode: ImportMode = DEFAULT_IMPORT_MODE) {
  if (typeof window === "undefined") return;
  if (looksLikeUrl(prompt)) {
    sessionStorage.setItem("targetUrl", prompt);
    sessionStorage.setItem("autoStart", "true");
    sessionStorage.setItem("navroopImportMode", importMode);
    return;
  }
  sessionStorage.setItem("navroopPrompt", prompt);
}

export async function createProjectFromPrompt(
  prompt: string,
  stack: StackId,
  designDirection?: DesignDirectionId,
  importMode: ImportMode = DEFAULT_IMPORT_MODE,
) {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, status: "idle", stack, designDirection, importMode }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      error: String(data.error || "Could not create project"),
    };
  }
  armProjectGeneration(prompt, importMode);
  return { ok: true as const, project: data.project as { id: string } };
}
