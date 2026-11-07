import type {
  AdapterContext,
  AdapterDescriptor,
  BrowserSnapshotNode,
  ComputerRef,
} from "./types.js";

export type PageDecisionKind = "click" | "fill" | "type";

export interface PageDecisionAttempt {
  ref: string;
  kind: PageDecisionKind;
  changed: boolean;
}

export interface PageDecisionRequest {
  goal: string;
  /** Visible controls only; input and option values are excluded. */
  elements: BrowserSnapshotNode[];
  excerpt: string;
  url: string;
  title: string;
  history: PageDecisionAttempt[];
  signal?: AbortSignal;
}

export interface PageDecisionCandidate {
  ref: string;
  kind: PageDecisionKind;
  confidence: number;
}

export interface PageDecision {
  candidates: readonly PageDecisionCandidate[];
  goalMet: number;
  stuck: number;
  blocked: number;
  error?: string;
}

/** Provider-neutral, opt-in decisions. Vision capability does not grant permission to capture pixels. */
export interface PageDecider {
  describe(): AdapterDescriptor<{ vision: boolean }>;
  decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision>;
}

export const PAGE_DECISION_MAX_ELEMENTS = 240;
export const PAGE_DECISION_MAX_EXCERPT_CHARS = 4_000;
