// @vitest-environment jsdom
/**
 * Integration coverage for the component itself.
 *
 * Run with:  npx vitest run --environment jsdom component.test.tsx
 *
 * The offline provider is deterministic and makes no network call, so a full
 * nine-stage run is exercised here end to end: mount, compile, verify, and the
 * revision bookkeeping that decides whether the result is shippable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import SystemPromptBuilderPipeline from "./SystemPromptBuilderPipeline";

/** Chips render as radios and actions as buttons; accept either. */
const clickByName = (name: RegExp | string): void => {
  const found = screen.queryByRole("button", { name }) ?? screen.getByRole("radio", { name });
  fireEvent.click(found);
};

beforeEach(() => {
  window.localStorage?.clear();
  // The sandbox storage API is optional; the adapter must cope with its absence.
  delete (window as { storage?: unknown }).storage;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mount", () => {
  it("renders without throwing and shows the stage list", () => {
    render(<SystemPromptBuilderPipeline />);
    expect(screen.getByText(/SYSTEM PROMPT/)).toBeTruthy();
    for (const name of ["DECONSTRUCT", "CALIBRATE", "COMPILE", "HARDEN", "LINT", "PREVIEW"]) {
      expect(screen.getAllByText(new RegExp(name)).length).toBeGreaterThan(0);
    }
  });

  it("makes no network request on mount", () => {
    const spy = vi.spyOn(globalThis, "fetch" as never);
    render(<SystemPromptBuilderPipeline />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("exposes every interactive control to the keyboard", () => {
    render(<SystemPromptBuilderPipeline />);
    // Provider and stakes selectors were plain divs in an earlier revision and
    // could not be reached or operated without a mouse.
    expect(screen.getAllByRole("radiogroup").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("switch").length).toBe(9);
    for (const el of screen.getAllByRole("switch")) expect(el.tagName).toBe("BUTTON");
  });

  it("reports the default MEDIUM stakes as MINIMAL depth", () => {
    render(<SystemPromptBuilderPipeline />);
    expect(screen.getByText("MINIMAL")).toBeTruthy();
  });
});

describe("stakes escalation", () => {
  it("regression: an escalating brief re-plans the stage set", async () => {
    render(<SystemPromptBuilderPipeline />);
    const briefBox = screen.getByLabelText("Raw intent brief");

    // Pick the lowest stakes explicitly, which applies the TINY plan.
    clickByName("LOW");
    await waitFor(() => expect(screen.getByText("TINY")).toBeTruthy());
    const criticSwitch = () => screen.getByRole("switch", { name: /the Critique stage/ });
    expect(criticSwitch().getAttribute("aria-checked")).toBe("false");

    // Now write a brief that routing must escalate to SAFETY-CRITICAL. A prior
    // revision froze the plan after any manual selection, leaving Critique and
    // Refine switched off while the UI advertised COMPREHENSIVE.
    fireEvent.change(briefBox, { target: { value: "An assistant supporting medical diagnosis triage." } });
    await waitFor(() => expect(screen.getByText("COMPREHENSIVE")).toBeTruthy());
    await waitFor(() => expect(criticSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("switch", { name: /the Refine stage/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("locks stakes below the routing floor", async () => {
    render(<SystemPromptBuilderPipeline />);
    fireEvent.change(screen.getByLabelText("Raw intent brief"), {
      target: { value: "An assistant supporting medical diagnosis triage." },
    });
    await waitFor(() => expect(screen.getByRole("radio", { name: "LOW" })).toHaveProperty("disabled", true));
    expect(screen.getByRole("radio", { name: "SAFETY" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("offline pipeline run", () => {
  const selectMockProvider = (): void => clickByName(/Mock · Offline/);

  it("runs every enabled stage and produces a shippable prompt", async () => {
    render(<SystemPromptBuilderPipeline />);
    selectMockProvider();
    clickByName(/▶ COMPILE/);

    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });

    // Lint must have validated the same revision the prompt is at.
    expect(screen.getByText(/PASS/)).toBeTruthy();
    const revisionButton = screen.getByRole("button", { name: /revision details/i });
    expect(within(revisionButton).getByText(/R\d+ ✓/)).toBeTruthy();
  });

  it("regression: the compiled prompt clears every deterministic gate", async () => {
    render(<SystemPromptBuilderPipeline />);
    selectMockProvider();
    clickByName(/▶ COMPILE/);
    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });

    // Open the Lint stage and confirm it reported no findings at all.
    clickByName(/07 · LINT/);
    await waitFor(() => expect(screen.getByText(/all gates green/)).toBeTruthy());
  });

  it("enables saving only once verification is current", async () => {
    render(<SystemPromptBuilderPipeline />);
    selectMockProvider();
    const saveButton = () => screen.getByRole("button", { name: /SAVE/ });
    expect(saveButton()).toHaveProperty("disabled", true);

    clickByName(/▶ COMPILE/);
    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });
    expect(saveButton()).toHaveProperty("disabled", false);
  });

  it("records prior revisions as later stages supersede the prompt", async () => {
    render(<SystemPromptBuilderPipeline />);
    selectMockProvider();
    clickByName(/▶ COMPILE/);
    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });

    clickByName(/revision details/i);
    // Compile then Harden both write the prompt, so exactly one supersession is archived.
    await waitFor(() => expect(screen.getByText(/PRIOR REVISIONS/)).toBeTruthy());
    expect(screen.getByText(/superseded by Harden/)).toBeTruthy();
  });

  it("RESET clears output and returns the revision counter to zero", async () => {
    render(<SystemPromptBuilderPipeline />);
    selectMockProvider();
    clickByName(/▶ COMPILE/);
    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });

    clickByName(/RESET/);
    await waitFor(() => expect(screen.queryByText(/◈ SHIP/)).toBeNull());
    expect(screen.getByText(/The compiled system prompt appears here/)).toBeTruthy();
  });
});

describe("template editing and staleness", () => {
  it("marks a stage and its descendants stale, then reruns only from there", async () => {
    render(<SystemPromptBuilderPipeline />);
    clickByName(/Mock · Offline/);
    clickByName(/▶ COMPILE/);
    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });

    clickByName(/04 · HARDEN/);
    clickByName(/EDIT STAGE/);
    const editor = await screen.findByLabelText(/Harden stage template/);
    fireEvent.change(editor, { target: { value: "STEP 3 — GUARDRAILING.\n{prompt}\nOutput only the prompt." } });

    // Harden plus every descendant of it should now be stale, and the rerun
    // control should offer to resume from that point rather than the start.
    const rerun = await screen.findByRole("button", { name: /RERUN \d+ STALE/ });
    expect(rerun.textContent).toMatch(/RERUN [1-9]\d* STALE/);
    expect(screen.getAllByText(/^STALE$/).length).toBeGreaterThanOrEqual(1);
  });

  it("regression: an unknown template variable names itself in the error", async () => {
    render(<SystemPromptBuilderPipeline />);
    clickByName(/Mock · Offline/);
    clickByName(/01 · DECONSTRUCT/);
    clickByName(/EDIT STAGE/);
    const editor = await screen.findByLabelText(/Deconstruct stage template/);
    fireEvent.change(editor, { target: { value: "STEP 1 — ANALYSIS\n{breif}" } });
    clickByName(/DONE/);
    clickByName(/RUN THIS/);
    await waitFor(() => expect(screen.getByText(/unknown variable/i)).toBeTruthy());
    expect(screen.getByText(/\{breif\}/)).toBeTruthy();
  });

  it("regression: single-brace text in upstream output does not abort the next stage", async () => {
    // Deconstruct's fixture describes a JSON envelope, so its output contains
    // brace shapes. Validating the rendered text used to mistake those for
    // unresolved placeholders and fail every downstream build stage.
    render(<SystemPromptBuilderPipeline />);
    clickByName(/Mock · Offline/);
    clickByName(/▶ COMPILE/);
    await waitFor(() => expect(screen.getByText(/◈ SHIP/)).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByText(/unresolved placeholder/i)).toBeNull();
  });
});

describe("provider gating", () => {
  it("blocks the run until a key is supplied", () => {
    render(<SystemPromptBuilderPipeline />);
    clickByName(/OpenAI/);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "" } });
    expect(screen.getByText(/add an API key/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /▶ COMPILE/ })).toHaveProperty("disabled", true);
  });

  it("never persists the API key", async () => {
    render(<SystemPromptBuilderPipeline />);
    clickByName(/OpenAI/);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-secret-value-1234567890" } });
    await waitFor(() => {
      const dump = JSON.stringify({ ...window.localStorage });
      expect(dump).not.toContain("sk-secret-value");
    });
  });

  it("lets Lint run offline even with no provider configured", () => {
    render(<SystemPromptBuilderPipeline />);
    clickByName(/Ollama/);
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "" } });
    clickByName(/07 · LINT/);
    expect(screen.getByRole("button", { name: /RUN THIS/ })).toHaveProperty("disabled", false);
  });
});
