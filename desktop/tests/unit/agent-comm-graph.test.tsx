import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const groupReader = vi.hoisted(() => ({ listAgents: vi.fn(), getDirectMessages: vi.fn(), listGroups: vi.fn(), getGroupMessages: vi.fn() }));
const dashboardState = vi.hoisted(() => ({ project: null as null | { fluxDir: string; eventsPath: string; projectName: string; projectRoot: string } }));
vi.mock("../../src/lib/group-reader", () => groupReader);
vi.mock("../../src/store/dashboard-store", () => ({ useDashboardStore: (selector: (state: typeof dashboardState) => unknown) => selector(dashboardState) }));

import { AgentCommGraph, aggregateDirectConversations, isEdgeRelevant, selectConversationEdges, summarizeGroups, type DirectConversationEdge } from "../../src/components/AgentCommGraph";

const message = (from: string, to: string, id: string) => ({ id, from, to, type: "text" as const, content: id, timestamp: 1, read: false });

describe("Communication lane semantics", () => {
  it("never turns group membership into traffic", () => {
    const groups = summarizeGroups([
      { id: "all", name: "All Agents", type: "all", members: ["A", "B"], created: 1 },
      { id: "team", name: "Team", type: "team", members: ["A", "B"], created: 2 },
    ], new Map());
    expect(groups.map((item) => item.system)).toEqual([true, false]);
    expect(aggregateDirectConversations([])).toEqual([]);
  });

  it("preserves message direction and aggregates only the same direction", () => {
    expect(aggregateDirectConversations([
      message("A", "B", "1"), message("B", "A", "2"), message("A", "B", "3"),
    ])).toEqual([
      { from: "A", to: "B", count: 2 },
      { from: "B", to: "A", count: 1 },
    ]);
  });

  it("ranks traffic and limits the default high-density view", () => {
    const edges: DirectConversationEdge[] = Array.from({ length: 30 }, (_, index) => ({ from: `A${index}`, to: `B${index}`, count: index + 1 }));
    const visible = selectConversationEdges(edges, null);
    expect(visible).toHaveLength(12);
    expect(visible[0].count).toBe(30);
    expect(selectConversationEdges(edges, null, 30)).toHaveLength(30);
    expect(selectConversationEdges(edges, { type: "agent", name: "A1" })).toEqual([{ from: "A1", to: "B1", count: 2 }]);
  });

  it("requires both endpoints to be inside a focused group", () => {
    const focus = { type: "group" as const, id: "g", members: ["A", "B"] };
    expect(isEdgeRelevant({ from: "A", to: "B", count: 1 }, focus)).toBe(true);
    expect(isEdgeRelevant({ from: "A", to: "C", count: 1 }, focus)).toBe(false);
  });
});

describe("Communication inspector with 64 agents", () => {
  beforeEach(() => {
    dashboardState.project = { fluxDir: "C:/test/.agentflux", eventsPath: "x", projectName: "test", projectRoot: "C:/test" };
    groupReader.listAgents.mockResolvedValue(Array.from({ length: 64 }, (_, index) => ({ name: `agent-${String(index).padStart(2, "0")}`, role: index % 2 ? "reviewer" : "implementer", status: index % 3 ? "idle" : "running" })));
    groupReader.getDirectMessages.mockResolvedValue(Array.from({ length: 55 }, (_, index) => message("agent-00", `agent-${String(index + 1).padStart(2, "0")}`, `${index}`)));
    groupReader.listGroups.mockResolvedValue([
      { id: "all", name: "All Agents", type: "all", members: Array.from({ length: 64 }, (_, i) => `agent-${String(i).padStart(2, "0")}`), created: 1 },
      { id: "review", name: "Review Cell", type: "team", members: ["agent-00", "agent-01", "agent-02", "agent-63"], created: 2 },
    ]);
    groupReader.getGroupMessages.mockResolvedValue([]);
  });

  it("shows ranked non-crossing lanes instead of a node-link canvas", async () => {
    const { container } = render(<AgentCommGraph />);
    await waitFor(() => expect(screen.getAllByTestId("direct-conversation-edge")).toHaveLength(12));
    expect(screen.queryByTestId("communication-graph")).toBeNull();
    expect(container.querySelectorAll("line")).toHaveLength(0);
    expect(screen.getByRole("columnheader", { name: "Sender" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Recipient" })).toBeInTheDocument();
    expect(screen.getByText("Show next 43 of 43 remaining links")).toBeInTheDocument();
    expect(screen.getByText(/Directory: 64 registered/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Sender agent-00 to recipient agent-01, 1 direct messages/ })).toBeInTheDocument();
    expect(screen.getAllByText("→").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Focus sender agent-00, status running/ }).length).toBeGreaterThan(0);
  });

  it("filters before applying the limit and supports keyboard-focusable controls", async () => {
    render(<AgentCommGraph />);
    const group = await screen.findByRole("button", { name: /Review Cell/i });
    fireEvent.click(group);
    expect(screen.getAllByTestId("direct-conversation-edge")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Clear scope" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Focus (sender|recipient)/ })[0]).toHaveClass("af-agent-endpoint");
    expect(screen.getByText("agent-63")).toBeInTheDocument();
    expect(screen.queryByText("agent-62")).not.toBeInTheDocument();
  });

  it("reveals dense focused traffic in bounded increments and can collapse", async () => {
    render(<AgentCommGraph />);
    await screen.findAllByRole("button", { name: /Focus sender agent-00/ });
    fireEvent.click(screen.getAllByRole("button", { name: /Focus sender agent-00/ })[0]);
    expect(screen.getAllByTestId("direct-conversation-edge")).toHaveLength(12);
    fireEvent.click(screen.getByText("Show next 43 of 43 remaining links"));
    expect(screen.getAllByTestId("direct-conversation-edge")).toHaveLength(55);
    fireEvent.click(screen.getByText("Collapse to top 12"));
    expect(screen.getAllByTestId("direct-conversation-edge")).toHaveLength(12);
  });

  it("handles a zero-edge dataset without inventing traffic", async () => {
    groupReader.getDirectMessages.mockResolvedValue([]);
    render(<AgentCommGraph />);
    await screen.findByText("No observed direct conversations in this scope.");
    expect(screen.queryByTestId("direct-conversation-edge")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^agent-/ })).toHaveLength(64);
  });
});
