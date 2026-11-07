// @vitest-environment jsdom
import type { McpSourcePreset } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceFormView, useSourceForm } from "./source-form";

vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return Object.fromEntries([
    ...[
      "Field",
      "FieldDescription",
      "FieldLabel",
      "SectionHeading",
      "NativeSelect",
      "NativeSelectOption",
    ].map((name) => [name, container]),
    [
      "Button",
      ({
        children,
        onClick,
        type,
      }: {
        children?: ReactNode;
        onClick?: () => void;
        type?: string;
      }) => createElement("button", { type: type ?? "button", onClick }, children),
    ],
    [
      "Input",
      (props: {
        id?: string;
        type?: string;
        value?: string;
        autoComplete?: string;
        placeholder?: string;
        readOnly?: boolean;
        onChange?: () => void;
      }) =>
        createElement("input", {
          id: props.id,
          type: props.type,
          value: props.value,
          autoComplete: props.autoComplete,
          placeholder: props.placeholder,
          readOnly: props.readOnly,
          onChange: props.onChange,
        }),
    ],
  ]);
});
vi.mock("../../lib/rpc", () => ({ rpc: {}, rpcForSpace: () => ({}), createSpaceRpc: () => ({}) }));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: vi.fn() }));
vi.mock("../../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function StartedSourceForm({ preset }: { preset: McpSourcePreset }) {
  const form = useSourceForm();
  useEffect(() => {
    form.start("mcp", preset);
  }, []);
  return (
    <SourceFormView
      form={form}
      installing={false}
      sourceError={null}
      onBack={() => {}}
      onSubmit={() => {}}
    />
  );
}

async function renderPreset(preset: McpSourcePreset) {
  await act(async () => root.render(<StartedSourceForm preset={preset} />));
}

function credentialInput() {
  return host.querySelector<HTMLInputElement>('input[type="password"]');
}

it("hides the credential prompt for a no-auth preset", async () => {
  await renderPreset({
    id: "deepwiki",
    name: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    auth: "none",
  });
  expect(credentialInput()).toBeNull();
});

it("prompts for a bearer token on a bearer preset", async () => {
  await renderPreset({
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "bearer",
  });
  expect(credentialInput()).not.toBeNull();
});

it("treats a preset reply without auth as bearer", async () => {
  const legacy = {
    id: "legacy-source",
    name: "Legacy source",
    url: "https://legacy.example/mcp",
  } as McpSourcePreset;
  await renderPreset(legacy);
  expect(credentialInput()).not.toBeNull();
  expect(host.textContent).toContain("Bearer token");
});

it("pins the header name and prompts for an API key on a header preset", async () => {
  await renderPreset({
    id: "agentmail",
    name: "AgentMail",
    url: "https://mcp.agentmail.to/mcp",
    auth: "header",
    authHeader: "x-api-key",
  });
  expect(host.querySelector<HTMLInputElement>("#source-header")?.value).toBe("x-api-key");
  expect(host.querySelector<HTMLInputElement>("#source-header")?.readOnly).toBe(true);
  expect(credentialInput()).not.toBeNull();
  expect(host.textContent).toContain("API key");
});

it("sends an OAuth preset to the browser sign-in path", async () => {
  await renderPreset({
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    auth: "oauth",
  });
  expect(credentialInput()).toBeNull();
  expect(host.textContent).toContain("Save and sign in");
});
