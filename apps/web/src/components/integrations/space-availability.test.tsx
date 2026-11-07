// @vitest-environment jsdom
import type { SpaceAvailability } from "@rakazo/contracts";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { AvailabilityControl } from "./space-availability";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  spaces: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({ rpc: { availability: { set: mocks.set } } }));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({ spaces: { list: { queryOptions: () => ({ queryKey: ["spaces"] }) } } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { spaces: mocks.spaces() } }),
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: ({ value }: { value: number }) => <>{value}</>,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + (values[index] ?? "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { cloneElement } = await import("react");
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Button: ({ children, ...props }: ComponentProps<"button">) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    DropdownMenu: Plain,
    DropdownMenuContent: Plain,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: ({ children, render }: { children?: ReactNode; render: ReactElement }) =>
      cloneElement(render, {}, children),
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange,
    }: {
      children?: ReactNode;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
      >
        {children}
      </button>
    ),
  };
});

beforeEach(() => {
  mocks.set.mockReset().mockResolvedValue(undefined);
  mocks.spaces.mockReset();
});

async function render(kind: "mcpServer" | "skill", availability: SpaceAvailability) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <AvailabilityControl
        kind={kind}
        id="item_1"
        availability={availability}
        onChanged={() => undefined}
      />,
    ),
  );
  return { host, root };
}

it("lets an MCP server be available in no space", async () => {
  mocks.spaces.mockReturnValue([
    { id: "work", name: "Work" },
    { id: "home", name: "Home" },
  ]);
  const { host, root } = await render("mcpServer", { allSpaces: false, spaceIds: ["work"] });
  try {
    const work = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((item) => item.textContent === "Work");
    expect(work?.getAttribute("aria-checked")).toBe("true");
    await act(async () => work?.click());
    expect(mocks.set).toHaveBeenCalledWith({
      kind: "mcpServer",
      id: "item_1",
      allSpaces: false,
      spaceIds: [],
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps another kind of item in a space when its last one is unchecked", async () => {
  mocks.spaces.mockReturnValue([
    { id: "work", name: "Work" },
    { id: "home", name: "Home" },
  ]);
  const { host, root } = await render("skill", { allSpaces: false, spaceIds: ["work"] });
  try {
    const work = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((item) => item.textContent === "Work");
    await act(async () => work?.click());
    expect(mocks.set).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("lets a server leave its only space", async () => {
  mocks.spaces.mockReturnValue([{ id: "work", name: "Work" }]);
  const { host, root } = await render("mcpServer", { allSpaces: false, spaceIds: ["work"] });
  try {
    const work = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((item) => item.textContent === "Work");
    expect(work?.getAttribute("aria-checked")).toBe("true");
    await act(async () => work?.click());
    expect(mocks.set).toHaveBeenCalledWith({
      kind: "mcpServer",
      id: "item_1",
      allSpaces: false,
      spaceIds: [],
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps a parked server reachable to put it back into a space", async () => {
  mocks.spaces.mockReturnValue([{ id: "work", name: "Work" }]);
  const { host, root } = await render("mcpServer", { allSpaces: false, spaceIds: [] });
  try {
    expect(host.textContent).toContain("No spaces");
    const work = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
    ).find((item) => item.textContent === "Work");
    await act(async () => work?.click());
    expect(mocks.set).toHaveBeenCalledWith({
      kind: "mcpServer",
      id: "item_1",
      allSpaces: false,
      spaceIds: ["work"],
    });
  } finally {
    await act(async () => root.unmount());
  }
});
